import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSession} from '../src/worker-session';
import {packBackup, unpackBackup} from '../src/backup';
import {testExtensions} from './fixtures/extensions';
import type {WorkerResponse} from '../src/connection';

test('backup checksums and format reject truncation, tampering and incompatible engine versions', async () => {
  const backup = await packBackup(new Blob(['test snapshot']), '18.6');
  assert.equal(await (await unpackBackup(backup)).snapshot.text(), 'test snapshot');
  await assert.rejects(unpackBackup(backup.slice(0, backup.size - 1)), /校验/);
  const bytes = new Uint8Array(await backup.arrayBuffer()); bytes[bytes.length - 1] ^= 1;
  await assert.rejects(unpackBackup(new Blob([bytes])), /校验/);
  await assert.rejects(unpackBackup(new Blob([(await backup.text()).replace('0.5.11','0.0.00')])), /不兼容/);
  await assert.rejects(unpackBackup(new Blob(['not a backup'])), /pgbackup/);
});

for (const mode of ['memory','persistent']) test(`${mode}: complete backup, restore, rollback and interrupted restore recovery`, {timeout:90_000}, async t => {
  const directory = await mkdtemp(join(tmpdir(),'pg-backup-'));
  let journal: Blob | undefined, failOnce = false, failErase = false, failPostGIS = false;
  const resourceLoads: boolean[] = [];
  const pending = new Map<number, {resolve:(value:any)=>void; reject:(error:Error)=>void}>(); let id = 0;
  const create = async (requestedMode: string, checkpoint?: Blob, withPostGIS = false) => {
    resourceLoads.push(withPostGIS);
    if (withPostGIS && failPostGIS) { failPostGIS = false; throw Error('simulated PostGIS download failure'); }
    if (requestedMode === mode && checkpoint && failOnce) { failOnce = false; throw Error('simulated restore failure'); }
    return PGlite.create({dataDir:requestedMode === 'memory' ? 'memory://' : directory,loadDataDir:checkpoint,extensions:testExtensions(withPostGIS)});
  };
  const makeSession = () => createSession(create, async () => { if (failErase) throw Error('simulated interruption'); await rm(directory,{recursive:true,force:true}); }, (response:WorkerResponse) => {
    if (response.phase) return;
    const item = pending.get(response.id)!; pending.delete(response.id);
    if (response.error) item.reject(Object.assign(Error(response.error.message),response.error)); else item.resolve(response.data);
  }, {read:async()=>journal, write:async snapshot=>{journal=snapshot;}, clear:async()=>{journal=undefined;}});
  let handle = makeSession();
  const call = (method: string, payload: object = {}):Promise<any> => new Promise((resolve,reject)=>{const next=++id; pending.set(next,{resolve,reject}); handle({id:next,method,payload});});
  const run = (sql:string) => call('execute',{sql,mode:'run'});
  try {
    const initial = await call('init',{mode});
    assert.equal(initial.extensions.find((extension:any)=>extension.name==='postgis').downloadable, true);
    assert.ok(resourceLoads.every(loaded=>!loaded), 'ordinary startup does not load PostGIS');
    await run('CREATE TABLE optional_check (value int); INSERT INTO optional_check VALUES (42);');
    await t.test('optional loading protects transactions and temporary tables and recovers from failed downloads', async()=>{
      await run('BEGIN; INSERT INTO optional_check VALUES (99);');
      await assert.rejects(call('enable-extensions',{names:['postgis']}),/COMMIT/);
      await run('ROLLBACK; CREATE TEMP TABLE unsaved_temp(value int); INSERT INTO unsaved_temp VALUES (7);');
      await assert.rejects(call('enable-extensions',{names:['postgis']}),/临时表/);
      assert.deepEqual((await run('SELECT value FROM unsaved_temp')).results[0].rows,[[7]]);
      await run('DROP TABLE unsaved_temp;');
      assert.ok(resourceLoads.every(loaded=>!loaded));
      failPostGIS=true;
      await assert.rejects(call('enable-extensions',{names:['postgis']}),/可重试启用/);
      assert.deepEqual((await run('SELECT value FROM optional_check')).results[0].rows,[[42]]);
      assert.equal((await call('extensions')).find((extension:any)=>extension.name==='postgis').installedVersion,null);
    });
    await call('enable-extensions',{names:['vector', 'postgis']});
    assert.deepEqual((await run('SELECT value FROM optional_check')).results[0].rows,[[42]]);
    await run("CREATE TABLE backup_vectors(id int PRIMARY KEY, embedding vector(3)); INSERT INTO backup_vectors VALUES (1,'[1,0,0]'); CREATE INDEX backup_hnsw ON backup_vectors USING hnsw(embedding vector_l2_ops);");
    await run('CREATE TABLE backup_places(id int PRIMARY KEY, location geometry(Point, 4326)); INSERT INTO backup_places VALUES (1, ST_SetSRID(ST_MakePoint(116.397, 39.918), 4326)); CREATE INDEX backup_places_gist ON backup_places USING gist(location);');
    const backup:Blob = await call('backup');
    await run('INSERT INTO backup_vectors VALUES (2,\'[0,1,0]\');');
    await t.test('restore preserves extension data, indexes and full row sets',async()=>{
      const info = await call('restore',{file:backup});
      assert.ok(info.tables.some((table:any)=>table.name==='backup_vectors' && table.indexes.some((index:any)=>index.name==='backup_hnsw')));
      assert.ok(info.extensions.find((extension:any)=>extension.name==='vector').installedVersion);
      assert.ok(info.extensions.find((extension:any)=>extension.name==='postgis').installedVersion);
      assert.ok(info.tables.some((table:any)=>table.name==='backup_places' && table.indexes.some((index:any)=>index.name==='backup_places_gist')));
      assert.deepEqual((await run('SELECT ST_AsText(location) FROM backup_places')).results[0].rows,[['POINT(116.397 39.918)']]);
      assert.deepEqual((await run('SELECT id FROM backup_vectors')).results[0].rows,[[1]]);
      assert.equal(journal,undefined);
    });
    await t.test('corrupted and invalid snapshots leave current data usable',async()=>{
      await assert.rejects(call('restore',{file:backup.slice(0,backup.size-1)}),/校验/);
      const invalid = await packBackup(new Blob(['not a tar archive']), (await unpackBackup(backup)).metadata.postgres);
      await assert.rejects(call('restore',{file:invalid}));
      assert.deepEqual((await run('SELECT id FROM backup_vectors')).results[0].rows,[[1]]);
      await run('BEGIN');
      await assert.rejects(call('backup'),/COMMIT/);
      await assert.rejects(call('restore',{file:backup}),/COMMIT/);
      await run('ROLLBACK');
    });
    if(mode==='persistent') {
      await t.test('failed replacement rolls back to the original database',async()=>{
        await run("INSERT INTO backup_vectors VALUES (3,'[0,0,1]')"); failOnce=true;
        await assert.rejects(call('restore',{file:backup}),/原数据库已恢复/);
        assert.deepEqual((await run('SELECT id FROM backup_vectors ORDER BY id')).results[0].rows,[[1],[3]]);
        assert.equal(journal,undefined);
      });
      await t.test('a replacement interrupted after closing the database recovers on next startup',async()=>{
        failErase=true;
        await assert.rejects(call('restore',{file:backup}), error => {
          assert.equal((error as Error & {code:string}).code, 'DATABASE_UNAVAILABLE');
          assert.match((error as Error).message, /重试连接/); return true;
        });
        assert.ok(journal); failErase=false;
        handle=makeSession(); await call('init',{mode});
        assert.deepEqual((await run('SELECT id FROM backup_vectors ORDER BY id')).results[0].rows,[[1],[3]]);
        assert.equal(journal,undefined);
      });
    }
    // Close the database through reset, then let the session close explicitly below.
    await call('close');
  } finally { await rm(directory,{recursive:true,force:true}); }
});

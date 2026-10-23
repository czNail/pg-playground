import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {extensionCatalog, extensionStates, enableExtensions, extensionExample} from '../src/extensions';
import {execute} from '../src/database';
import {testExtensions} from './fixtures/extensions';

test('all supported extensions execute real examples and survive a memory checkpoint', {timeout:60_000}, async t => {
  let db = await PGlite.create({extensions: testExtensions(true)});
  try {
    const initial = await extensionStates(db);
    assert.equal(initial.length, 10);
    assert.ok(initial.every(item => item.availableVersion && !item.installedVersion));
    await assert.rejects(enableExtensions(db, ['vector; DROP SCHEMA public CASCADE;']), /支持的扩展/);
    await db.exec('BEGIN');
    await assert.rejects(enableExtensions(db, ['vector']), /COMMIT/);
    await db.exec('ROLLBACK');
    const enabled = await enableExtensions(db, extensionCatalog.map(item => item.name));
    assert.ok(enabled.every(item => item.installedVersion && item.schema === 'public'));
    for (const item of extensionCatalog) await t.test(item.name, async () => {
      const result = await execute(db, extensionExample(item.name), 'run');
      assert.ok(result.results.at(-1)!.rows.length > 0);
      if (item.name === 'vector') assert.equal(result.results.at(-1)!.rows[0][0], 1);
      if (item.name === 'citext') assert.deepEqual(result.results.at(-1)!.rows, [[true, false]]);
    });
    assert.ok((await enableExtensions(db, ['vector'])).every(item => item.installedVersion), 'enabling twice preserves all states');
    await db.exec('DROP EXTENSION citext');
    assert.equal((await extensionStates(db)).find(item => item.name === 'citext')!.installedVersion, null);
    await db.exec('CREATE EXTENSION citext');
    assert.ok((await extensionStates(db)).find(item => item.name === 'citext')!.installedVersion);
    const snapshot = await db.dumpDataDir('none');
    await db.close();
    db = await PGlite.create({extensions: testExtensions(true), loadDataDir:snapshot});
    assert.ok((await extensionStates(db)).every(item => item.installedVersion));
    const nearest = await db.query<{id:number}>("SELECT id FROM playground_examples.vector_items ORDER BY embedding <=> '[1,0,0]'::vector LIMIT 1");
    assert.equal(nearest.rows[0].id, 1);
    assert.equal((await db.query<{point:string}>("SELECT ST_AsText(location) AS point FROM playground_examples.places WHERE id = 1")).rows[0].point, 'POINT(116.397 39.918)');
    assert.equal((await db.query<{srid:number}>("SELECT ST_SRID(ST_Transform(location, 3857)) AS srid FROM playground_examples.places WHERE id = 1")).rows[0].srid, 3857);
  } finally { await db.close(); }
});

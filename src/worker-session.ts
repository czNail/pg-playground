import type { PGlite } from '@electric-sql/pglite';
import { initialize, execute, schema } from './database';
import { extensionStates, enableExtensions } from './extensions';
import type { WorkerResponse } from './connection';
import { importCSV } from './csv';
import { packBackup, unpackBackup } from './backup';
import type { RestoreJournal } from './restore-journal';

/** Shared by the browser worker and the real-engine recovery tests. */
export function createSession(
  create: (mode: string, checkpoint?: Blob) => Promise<PGlite>,
  erase: () => Promise<void>,
  send: (response: WorkerResponse) => void,
  journal?: RestoreJournal
) {
  let db: PGlite | undefined;
  let mode = 'persistent';
  let queue = Promise.resolve();
  async function boot(checkpoint?: Blob) {
    db = await create(mode, checkpoint);
    const version = await initialize(db);
    return {version, tables: await schema(db), extensions: await extensionStates(db)};
  }
  async function snapshot() {
    // Never save an open or failed transaction as a recovery point.
    return mode === 'memory' && db && !db.isInTransaction() ? db.dumpDataDir('none') : undefined;
  }
  return (message: {id: number; method: string; payload: any}) => {
    const {id, method, payload} = message;
    queue = queue.then(async () => {
      try {
        let data: unknown;
        if (method === 'init') {
          mode = payload.mode;
          const recovery = mode === 'persistent' ? await journal?.read() : undefined;
          if (recovery) { await erase(); data = await boot(recovery); await journal!.clear(); }
          else data = await boot(payload.checkpoint);
        }
        else if (method === 'reset') {
          await db?.close(); db = undefined;
          if (mode !== 'memory') await erase();
          data = await boot();
        } else if (method === 'close') { await db?.close(); db = undefined; }
        else if (!db) throw Error('数据库尚未准备好。');
        else if (method === 'execute') {
          send({id, phase: 'running'});
          try { data = await execute(db, payload.sql, payload.mode); }
          finally { send({id, phase: 'saving'}); }
        } else if (method === 'csv-import') { data = await importCSV(db, payload); }
        else if (method === 'backup') {
          if (db.isInTransaction()) throw Error('请先 COMMIT 或 ROLLBACK 当前事务，再备份数据库。');
          const version = (await db.query<{v: string}>("SELECT current_setting('server_version') AS v")).rows[0].v;
          data = await packBackup(await db.dumpDataDir('none'), version);
        } else if (method === 'restore') {
          if (db.isInTransaction()) throw Error('请先 COMMIT 或 ROLLBACK 当前事务，再恢复数据库。');
          const {metadata, snapshot: incoming} = await unpackBackup(payload.file);
          const version = (await db.query<{v: string}>("SELECT current_setting('server_version') AS v")).rows[0].v;
          if (metadata.postgres !== version) throw Error(`备份 PostgreSQL 版本 ${metadata.postgres} 与当前 ${version} 不一致。`);
          // Validate in a disposable instance before touching the current database.
          const staged = await create('memory', incoming);
          try { await initialize(staged); await schema(staged); await extensionStates(staged); }
          finally { await staged.close(); }
          const original = await db.dumpDataDir('none');
          if (mode === 'persistent') await journal?.write(original);
          await db.close(); db = undefined;
          try {
            if (mode === 'persistent') await erase();
            data = await boot(incoming);
            if (mode === 'persistent') await journal?.clear();
          } catch (error) {
            await (db as PGlite | undefined)?.close().catch(() => {}); db = undefined;
            if (mode === 'persistent') await erase();
            await boot(original);
            if (mode === 'persistent') await journal?.clear();
            throw Error('恢复未完成，原数据库已恢复：' + (error as Error).message);
          }
        } else if (method === 'enable-extensions') data = {extensions: await enableExtensions(db, payload.names), tables: await schema(db)};
        else if (method === 'extensions') data = await extensionStates(db);
        else if (method === 'schema') data = await schema(db);
        else throw Error('未知操作。');
        const checkpoint = ['schema', 'extensions', 'backup'].includes(method) ? undefined : await snapshot();
        send({id, data, checkpoint});
      } catch (error) {
        const e = error as Error & {code?: string; detail?: string; hint?: string; position?: string};
        // A batch may have committed statements before a later statement failed.
        let checkpoint: Blob | undefined;
        try { checkpoint = await snapshot(); } catch { /* Retain the last valid recovery point. */ }
        send({id, checkpoint, error: {message: e.message || String(error), code: e.code, detail: e.detail, hint: e.hint, position: e.position}});
      }
    });
  };
}

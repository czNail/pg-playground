import type { PGlite } from '@electric-sql/pglite';
import { initialize, execute, schema } from './database';
import { extensionStates, enableExtensions, extensionInstallSQL } from './extensions';
import type { WorkerResponse } from './connection';
import { importCSV } from './csv';
import { packBackup, unpackBackup } from './backup';
import type { RestoreJournal } from './restore-journal';

/** Shared by the browser worker and the real-engine recovery tests. */
export function createSession(
  create: (mode: string, checkpoint?: Blob, withPostGIS?: boolean) => Promise<PGlite>,
  erase: () => Promise<void>,
  send: (response: WorkerResponse) => void,
  journal?: RestoreJournal
) {
  let db: PGlite | undefined;
  let mode = 'persistent';
  let queue = Promise.resolve();
  async function open(requestedMode: string, checkpoint?: Blob, withPostGIS = false): Promise<PGlite> {
    const opened = await create(requestedMode, checkpoint, withPostGIS);
    try {
      // The database remains the source of truth, including restored backups.
      const installed = await opened.query("SELECT 1 FROM pg_extension WHERE extname = 'postgis'");
      if (!withPostGIS && installed.rows.length) {
        const saved = requestedMode === 'memory' ? await opened.dumpDataDir('none') : undefined;
        await opened.close();
        return await create(requestedMode, saved, true);
      }
      return opened;
    } catch (error) { await opened.close().catch(() => {}); throw error; }
  }
  async function boot(checkpoint?: Blob) {
    db = await open(mode, checkpoint);
    const version = await initialize(db);
    return {version, tables: await schema(db), extensions: await extensionStates(db)};
  }
  async function snapshot() {
    // Never save an open or failed transaction as a recovery point.
    return mode === 'memory' && db && !db.isInTransaction() ? db.dumpDataDir('none') : undefined;
  }
  async function preparePostGIS() {
    if ((await db!.query("SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'")).rows.length) return;
    if (db!.isInTransaction()) throw Error('请先 COMMIT 或 ROLLBACK 当前事务，再启用 PostGIS。');
    if ((await db!.query('SELECT 1 FROM pg_class WHERE relnamespace = pg_my_temp_schema() LIMIT 1')).rows.length) {
      throw Error('首次启用 PostGIS 需要重连，请先保存并删除当前临时表，再重试启用。');
    }
    const saved = mode === 'memory' ? await db!.dumpDataDir('none') : undefined;
    await db!.close(); db = undefined;
    try {
      db = await open(mode, saved, true);
      await initialize(db);
    } catch (error) {
      await db?.close().catch(() => {}); db = undefined;
      await boot(saved);
      throw Error('PostGIS 加载未完成，数据库已重新连接，可重试启用：' + (error as Error).message);
    }
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
          const staged = await open('memory', incoming);
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
        } else if (method === 'enable-extensions') {
          extensionInstallSQL(payload.names);
          if (db.isInTransaction()) throw Error('请先 COMMIT 或 ROLLBACK 当前事务，再通过面板启用扩展。');
          if (payload.names.includes('postgis')) await preparePostGIS();
          data = {extensions: await enableExtensions(db!, payload.names), tables: await schema(db!)};
        }
        else if (method === 'extensions') data = await extensionStates(db);
        else if (method === 'schema') data = await schema(db);
        else throw Error('未知操作。');
        const checkpoint = ['schema', 'extensions', 'backup'].includes(method) ? undefined : await snapshot();
        send({id, data, checkpoint});
      } catch (error) {
        const e = error as Error & {code?: string; detail?: string; hint?: string; position?: string};
        if (e.code === '0A000' && e.message.includes('extension "postgis" is not available')) {
          e.hint = '请先在扩展面板启用 PostGIS，下载资源后再运行空间 SQL。';
        }
        // A batch may have committed statements before a later statement failed.
        let checkpoint: Blob | undefined;
        try { checkpoint = await snapshot(); } catch { /* Retain the last valid recovery point. */ }
        const unavailable = !db;
        send({id, checkpoint, error: {message: unavailable ? '数据库连接尚未恢复，请重试连接：' + e.message : e.message || String(error), code: unavailable ? 'DATABASE_UNAVAILABLE' : e.code, detail: e.detail, hint: e.hint, position: e.position}});
      }
    });
  };
}

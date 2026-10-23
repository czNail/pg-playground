import type { PGlite } from '@electric-sql/pglite';
import { initialize, execute, schema } from './database';
import { extensionStates, enableExtensions } from './extensions';
import type { WorkerResponse } from './connection';

/** Shared by the browser worker and the real-engine recovery tests. */
export function createSession(
  create: (mode: string, checkpoint?: Blob) => Promise<PGlite>,
  erase: () => Promise<void>,
  send: (response: WorkerResponse) => void
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
        if (method === 'init') { mode = payload.mode; data = await boot(payload.checkpoint); }
        else if (method === 'reset') {
          await db?.close(); db = undefined;
          if (mode !== 'memory') await erase();
          data = await boot();
        } else if (!db) throw Error('数据库尚未准备好。');
        else if (method === 'execute') {
          send({id, phase: 'running'});
          try { data = await execute(db, payload.sql, payload.mode); }
          finally { send({id, phase: 'saving'}); }
        } else if (method === 'enable-extensions') data = {extensions: await enableExtensions(db, payload.names), tables: await schema(db)};
        else if (method === 'extensions') data = await extensionStates(db);
        else if (method === 'schema') data = await schema(db);
        else throw Error('未知操作。');
        const checkpoint = method === 'schema' || method === 'extensions' ? undefined : await snapshot();
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

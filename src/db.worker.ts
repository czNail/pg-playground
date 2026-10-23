/// <reference lib="webworker" />
import { PGlite } from '@electric-sql/pglite';
import wasmURL from '../node_modules/@electric-sql/pglite/dist/pglite.wasm?url';
import initURL from '../node_modules/@electric-sql/pglite/dist/initdb.wasm?url';
import dataURL from '../node_modules/@electric-sql/pglite/dist/pglite.data?url';
import { initialize, execute, schema } from './database';
import { DATABASE_NAME, DATABASE_IDB_NAME } from './model';

let db: PGlite | undefined;
let queue = Promise.resolve();
async function checked(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`数据库资源加载失败（${response.status}），请刷新重试。`);
  return response;
}
async function boot(mode: string) {
  const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
    checked(wasmURL).then(r => r.arrayBuffer()).then(b => WebAssembly.compile(b)),
    checked(initURL).then(r => r.arrayBuffer()).then(b => WebAssembly.compile(b)),
    checked(dataURL).then(r => r.blob())
  ]);
  db = await PGlite.create({dataDir: mode === 'memory' ? 'memory://' : 'idb://' + DATABASE_NAME,
    pgliteWasmModule, initdbWasmModule, fsBundle});
  const version = await initialize(db);
  return {version, tables: await schema(db)};
}
async function reset(mode: string) {
  await db?.close();
  db = undefined;
  if (mode !== 'memory') await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_IDB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('数据库仍被占用，请关闭其他实验台标签页后重试。'));
  });
  return boot(mode);
}
self.onmessage = event => {
  const {id, method, payload} = event.data;
  queue = queue.then(async () => {
    try {
      let data: unknown;
      if (method === 'init') data = await boot(payload.mode);
      else if (method === 'reset') data = await reset(payload.mode);
      else if (!db) throw Error('数据库尚未准备好。');
      else if (method === 'execute') data = await execute(db, payload.sql, payload.mode);
      else if (method === 'schema') data = await schema(db);
      else throw Error('未知操作。');
      self.postMessage({id, data});
    } catch (error) {
      const e = error as Error & { code?: string; detail?: string; hint?: string; position?: string };
      self.postMessage({id, error: {message: e.message || String(error), code: e.code, detail: e.detail, hint: e.hint, position: e.position}});
    }
  });
};

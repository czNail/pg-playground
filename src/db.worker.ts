/// <reference lib="webworker" />
import { PGlite } from '@electric-sql/pglite';
import wasmURL from '../node_modules/@electric-sql/pglite/dist/pglite.wasm?url';
import initURL from '../node_modules/@electric-sql/pglite/dist/initdb.wasm?url';
import dataURL from '../node_modules/@electric-sql/pglite/dist/pglite.data?url';
import { createSession } from './worker-session';
import { extensionBundles } from './extension-bundles';
import { DATABASE_NAME, DATABASE_IDB_NAME } from './model';
import { restoreJournal } from './restore-journal';

async function checked(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`数据库资源加载失败（${response.status}），请刷新重试。`);
  return response;
}
async function create(mode: string, checkpoint?: Blob, withPostGIS = false) {
  const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
    checked(wasmURL).then(r => r.arrayBuffer()).then(b => WebAssembly.compile(b)),
    checked(initURL).then(r => r.arrayBuffer()).then(b => WebAssembly.compile(b)),
    checked(dataURL).then(r => r.blob())
  ]);
  const db = await PGlite.create({loadDataDir: checkpoint, dataDir: mode === 'memory' ? 'memory://' : 'idb://' + DATABASE_NAME,
    pgliteWasmModule, initdbWasmModule, fsBundle, extensions: extensionBundles(self.location.href, withPostGIS)});
  if (withPostGIS && !(await db.query("SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'")).rows.length) {
    await db.close();
    throw Error('PostGIS 资源加载失败，请检查网络后重试启用。');
  }
  return db;
}
async function erase() {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_IDB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('数据库仍被占用，请关闭其他实验台标签页后重试。'));
  });
}
const handle = createSession(create, erase, response => self.postMessage(response), restoreJournal);
self.onmessage = event => handle(event.data);

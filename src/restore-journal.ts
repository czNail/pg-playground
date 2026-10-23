// Separate from the database being replaced, so a closed tab can recover a restore in progress.
const JOURNAL = 'pg-playground:restore-journal-v1';
async function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(JOURNAL, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('recovery');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export interface RestoreJournal { read(): Promise<Blob | undefined>; write(snapshot: Blob): Promise<void>; clear(): Promise<void> }
export const restoreJournal: RestoreJournal = {
  async read() {
    const db = await open();
    try { return await new Promise<Blob | undefined>((resolve, reject) => {
      const tx = db.transaction('recovery', 'readonly');
      const request = tx.objectStore('recovery').get('database');
      let value: Blob | undefined;
      request.onsuccess = () => { value = request.result; };
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(tx.error);
    }); } finally { db.close(); }
  },
  async write(snapshot) { await update(snapshot); },
  async clear() { await update(); }
};
async function update(snapshot?: Blob) {
  const db = await open();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('recovery', 'readwrite');
    const store = tx.objectStore('recovery');
    if (snapshot) store.put(snapshot, 'database'); else store.delete('database');
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  }); } finally { db.close(); }
}

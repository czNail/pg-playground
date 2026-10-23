import DatabaseWorker from './db.worker?worker';
import { DatabaseConnection, type WorkerPort } from './connection';
import { DATABASE_NAME } from './model';

async function acquireLock() {
  if (!navigator.locks) throw Error('此浏览器不支持安全的本地数据库锁，请使用临时模式或更新浏览器。');
  return new Promise<() => void>((resolve, reject) => {
    navigator.locks.request(DATABASE_NAME, {ifAvailable: true}, async lock => {
      if (!lock) { reject(Error('另一个标签页正在使用实验台。请关闭它后点击“重试连接”，或使用临时模式。')); return; }
      await new Promise<void>(release => resolve(release));
    }).catch(reject);
  });
}
function createWorker(): WorkerPort {
  const worker = new DatabaseWorker();
  const port: WorkerPort = {onmessage: null, onerror: null,
    postMessage: message => worker.postMessage(message), terminate: () => worker.terminate()};
  worker.onmessage = event => port.onmessage?.({data: event.data});
  worker.onerror = () => port.onerror?.();
  return port;
}
export class DatabaseClient extends DatabaseConnection {
  constructor() { super(createWorker, acquireLock); }
}

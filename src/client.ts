import DatabaseWorker from './db.worker?worker';
import { DATABASE_NAME } from './model';

export class DatabaseClient {
  private worker?: Worker;
  private sequence = 0;
  private unlock?: () => void;
  private pending = new Map<number, {resolve: (data: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  mode = 'persistent';
  async start(mode = 'persistent') {
    this.stop();
    this.mode = mode;
    if (mode === 'persistent') {
      if (!navigator.locks) throw Error('此浏览器不支持安全的本地数据库锁，请使用临时模式或更新浏览器。');
      await new Promise<void>((resolve, reject) => {
        navigator.locks.request(DATABASE_NAME, {ifAvailable: true}, async lock => {
          if (!lock) { reject(Error('另一个标签页正在使用实验台。请关闭它后点击“重试连接”，或使用临时模式。')); return; }
          await new Promise<void>(release => { this.unlock = release; resolve(); });
        }).catch(reject);
      });
    }
    this.worker = new DatabaseWorker();
    this.worker.onmessage = ({data}) => {
      const item = this.pending.get(data.id);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(data.id);
      if (data.error) item.reject(Object.assign(new Error(data.error.message), data.error));
      else item.resolve(data.data);
    };
    this.worker.onerror = () => this.stop('数据库进程异常退出，请重试连接。');
    try { return await this.call('init', {mode}); }
    catch (error) { this.stop(); throw error; }
  }
  call<T = any>(method: string, payload: object = {}): Promise<T> {
    if (!this.worker) return Promise.reject(Error('数据库连接已断开，请重试连接。'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop('操作超过 60 秒，数据库进程已停止。部分已完成的语句可能已保存；请重试连接后检查。');
      }, 60_000);
      this.pending.set(id, {resolve, reject, timer});
      this.worker!.postMessage({id, method, payload});
    });
  }
  get connected() { return !!this.worker; }
  stop(message = '连接已关闭。') {
    this.worker?.terminate();
    this.worker = undefined;
    this.unlock?.();
    this.unlock = undefined;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error(message)); }
    this.pending.clear();
  }
}

import type { Table } from './model';

export interface BootInfo {version: string; tables: Table[]}
export type Activity = 'idle' | 'running' | 'saving' | 'recovering';
export interface WorkerResponse {
  id: number;
  phase?: 'running' | 'saving';
  checkpoint?: Blob;
  data?: any;
  error?: {message: string; code?: string; detail?: string; hint?: string; position?: string};
}
export interface WorkerPort {
  onmessage: ((event: {data: WorkerResponse}) => void) | null;
  onerror: (() => void) | null;
  postMessage(message: unknown): void;
  terminate(): void | Promise<unknown>;
}
type Pending = {
  method: string; timeoutMs: number; timer?: ReturnType<typeof setTimeout>;
  resolve: (data: any) => void; reject: (error: Error) => void;
};
export class QueryInterruptedError extends Error {
  constructor(public code: 'QUERY_TIMEOUT' | 'QUERY_CANCELLED', public info: BootInfo) {
    super(code === 'QUERY_TIMEOUT' ? '已达到所选运行时限，查询已停止，数据库连接已自动恢复。' : '查询已停止，数据库连接已自动恢复。');
  }
}

/** Keep the storage lease throughout recovery; never replay interrupted SQL. */
export class DatabaseConnection {
  private worker?: WorkerPort;
  private sequence = 0;
  private epoch = 0;
  private unlock?: () => void;
  private checkpoint?: Blob;
  private pending = new Map<number, Pending>();
  private recovering = false;
  private activity: Activity = 'idle';
  mode = 'persistent';
  onActivity?: (activity: Activity) => void;
  constructor(private createWorker: () => WorkerPort, private acquireLock: () => Promise<() => void>) {}
  private setActivity(activity: Activity) { this.activity = activity; this.onActivity?.(activity); }
  private spawn() {
    const worker = this.createWorker();
    this.worker = worker;
    worker.onmessage = ({data}) => {
      if (this.worker !== worker) return;
      const item = this.pending.get(data.id);
      if (!item) return;
      clearTimeout(item.timer);
      if (data.phase) {
        this.setActivity(data.phase);
        this.arm(data.id, item, data.phase === 'running' ? item.timeoutMs : 120_000);
        return;
      }
      this.pending.delete(data.id);
      if (data.checkpoint) this.checkpoint = data.checkpoint;
      if (item.method === 'execute') this.setActivity('idle');
      if (data.error) item.reject(Object.assign(new Error(data.error.message), data.error));
      else item.resolve(data.data);
    };
    worker.onerror = () => { if (this.worker === worker) this.stop('数据库进程异常退出，请重试连接。'); };
  }
  private arm(id: number, item: Pending, timeoutMs: number) {
    if (!timeoutMs) return;
    item.timer = setTimeout(() => {
      if (item.method === 'execute' && this.activity === 'running') void this.interrupt(id, 'QUERY_TIMEOUT');
      else this.stop('数据库启动或保存超过两分钟，请重试连接。');
    }, timeoutMs);
  }
  async start(mode = 'persistent'): Promise<BootInfo> {
    this.stop();
    const epoch = this.epoch;
    this.mode = mode;
    this.checkpoint = undefined;
    if (mode === 'persistent') {
      const unlock = await this.acquireLock();
      if (epoch !== this.epoch) { unlock(); throw Error('连接已关闭。'); }
      this.unlock = unlock;
    }
    this.spawn();
    try { return await this.call<BootInfo>('init', {mode}); }
    catch (error) { this.stop(); throw error; }
  }
  call<T = any>(method: string, payload: object = {}, options: {timeoutMs?: number} = {}): Promise<T> {
    if (!this.worker) return Promise.reject(Error('数据库连接已断开，请重试连接。'));
    if (this.recovering && method !== 'init') return Promise.reject(Error('数据库正在恢复，请稍候。'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const item: Pending = {method, timeoutMs: options.timeoutMs ?? 60_000, resolve, reject};
      this.pending.set(id, item);
      this.arm(id, item, 120_000);
      this.worker!.postMessage({id, method, payload});
    });
  }
  get connected() { return !!this.worker; }
  get canCancel() { return this.activity === 'running' && !this.recovering; }
  async cancel() {
    const entry = [...this.pending].find(([, item]) => item.method === 'execute');
    if (entry && this.canCancel) await this.interrupt(entry[0], 'QUERY_CANCELLED');
  }
  private async interrupt(id: number, reason: 'QUERY_TIMEOUT' | 'QUERY_CANCELLED') {
    const item = this.pending.get(id);
    if (!item || this.recovering) return;
    this.recovering = true;
    const epoch = this.epoch;
    clearTimeout(item.timer);
    this.pending.delete(id);
    this.setActivity('recovering');
    const old = this.worker;
    this.worker = undefined;
    try {
      await old?.terminate();
      if (epoch !== this.epoch) throw Error('连接已关闭。');
      this.spawn();
      const info = await this.call<BootInfo>('init', {mode: this.mode, checkpoint: this.checkpoint});
      item.reject(new QueryInterruptedError(reason, info));
    } catch (error) {
      if (epoch === this.epoch) this.stop();
      item.reject(Error('查询已停止，但自动恢复失败：' + (error as Error).message));
    } finally {
      if (epoch === this.epoch) { this.recovering = false; this.setActivity('idle'); }
    }
  }
  stop(message = '连接已关闭。') {
    this.epoch++;
    void this.worker?.terminate();
    this.worker = undefined;
    this.unlock?.(); this.unlock = undefined;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error(message)); }
    this.pending.clear();
    this.recovering = false;
    this.setActivity('idle');
  }
}

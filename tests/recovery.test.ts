import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseConnection, QueryInterruptedError, type WorkerPort } from '../src/connection';
import type { Execution } from '../src/model';

for (const mode of ['persistent', 'memory']) {
  test(`${mode}: stop a real blocked PostgreSQL query, retain saved data and resume`, {timeout: 60_000}, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pg-recovery-'));
    let acquired = 0, released = 0;
    const connection = new DatabaseConnection(() => {
      const worker = new Worker(new URL('./fixtures/database-worker.mjs', import.meta.url), {workerData: {directory}});
      const port: WorkerPort = {
        onmessage: null, onerror: null,
        postMessage: message => worker.postMessage(message), terminate: () => worker.terminate()
      };
      worker.on('message', data => port.onmessage?.({data}));
      worker.on('error', () => port.onerror?.());
      return port;
    }, async () => { acquired++; return () => { released++; }; });
    const run = (sql: string, timeoutMs = 0) => connection.call<Execution>('execute', {sql, mode:'run'}, {timeoutMs});
    try {
      await connection.start(mode);
      await run('CREATE TABLE recovery_check (value int); INSERT INTO recovery_check VALUES (42);');
      // A short timer starts after worker startup, and never replays the timed-out SQL.
      await assert.rejects(run('SELECT pg_sleep(1000); INSERT INTO recovery_check VALUES (99);', 100), error => {
        assert.ok(error instanceof QueryInterruptedError);
        assert.equal(error.code, 'QUERY_TIMEOUT');
        assert.ok(error.info.tables.some(table => table.name === 'recovery_check'));
        return true;
      });
      assert.equal(connection.connected, true);
      assert.deepEqual((await run('SELECT value FROM recovery_check')).results[0].rows, [[42]]);
      // Manual stop also works with no time limit, and rolls back an open transaction.
      await run('BEGIN; INSERT INTO recovery_check VALUES (7);');
      const running = new Promise<void>(resolve => { connection.onActivity = state => { if (state === 'running') resolve(); }; });
      const blocked = run('SELECT pg_sleep(1000);');
      const rejected = assert.rejects(blocked, error => error instanceof QueryInterruptedError && error.code === 'QUERY_CANCELLED');
      await running;
      await connection.cancel();
      await rejected;
      assert.deepEqual((await run('SELECT value FROM recovery_check')).results[0].rows, [[42]]);
      assert.equal(acquired, mode === 'persistent' ? 1 : 0, 'recovery keeps the existing lease');
      assert.equal(released, 0, 'no other tab can acquire the database during recovery');
    } finally {
      connection.stop();
      assert.equal(released, mode === 'persistent' ? 1 : 0);
      await rm(directory, {recursive: true, force: true});
    }
  });
}

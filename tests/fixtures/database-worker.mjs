import { parentPort, workerData } from 'node:worker_threads';
import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createSession } from '../../src/worker-session.ts';
import { testExtensions } from './extensions.ts';
const handle = createSession(
  (mode, checkpoint) => PGlite.create({dataDir: mode === 'memory' ? 'memory://' : workerData.directory, loadDataDir: checkpoint, extensions: testExtensions()}),
  () => rm(workerData.directory, {recursive:true, force:true}),
  response => parentPort.postMessage(response)
);
parentPort.on('message', handle);

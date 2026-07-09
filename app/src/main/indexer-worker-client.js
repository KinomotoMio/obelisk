import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWorkerBuildIndex({
  workerPath = path.join(__dirname, 'indexer-worker.js'),
  WorkerImpl = Worker,
} = {}) {
  let worker = null;
  let nextId = 1;
  const pending = new Map();

  const rejectPending = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const ensureWorker = () => {
    if (worker) return worker;
    worker = new WorkerImpl(workerPath, { type: 'module' });
    worker.on('message', (message) => {
      const current = pending.get(message.id);
      if (!current) return;
      pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message);
        error.stack = message.error.stack;
        current.reject(error);
      } else {
        current.resolve(message.result);
      }
    });
    worker.on('error', (error) => {
      rejectPending(error);
      worker = null;
    });
    worker.on('exit', (code) => {
      if (pending.size) rejectPending(new Error(`Indexer worker exited with code ${code}`));
      worker = null;
    });
    return worker;
  };

  const buildIndex = (args = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage({ id, args });
  });

  const stop = () => {
    const current = worker;
    worker = null;
    const termination = current?.terminate ? Promise.resolve(current.terminate()) : Promise.resolve();
    rejectPending(new Error('Indexer worker stopped'));
    return termination;
  };

  return { buildIndex, stop };
}

export { createWorkerBuildIndex };

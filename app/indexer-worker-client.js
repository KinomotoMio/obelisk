const path = require('path');
const { Worker } = require('worker_threads');

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
    worker = new WorkerImpl(workerPath);
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
    if (current?.terminate) current.terminate();
    rejectPending(new Error('Indexer worker stopped'));
  };

  return { buildIndex, stop };
}

module.exports = { createWorkerBuildIndex };

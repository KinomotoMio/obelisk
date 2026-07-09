import { parentPort } from 'node:worker_threads';
import { buildIndex } from './indexer.js';

parentPort.on('message', ({ id, args }) => {
  try {
    const result = buildIndex(args || {});
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        message: error.message,
        stack: error.stack,
      },
    });
  }
});

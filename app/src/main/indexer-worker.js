const { parentPort } = require('worker_threads');
const { buildIndex } = require('./indexer');

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

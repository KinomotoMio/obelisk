import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

// Kept CommonJS for the first electron-vite boot (no "type":"module" yet); the
// TS + ESM migration is a later stage. Each main-process module is its own input
// so it is emitted to out/main/<name>.js and the CommonJS require("./x") calls
// between them (and `new Worker(__dirname/indexer-worker.js)`) resolve at runtime.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.js'),
          indexer: resolve('src/main/indexer.js'),
          'indexer-service': resolve('src/main/indexer-service.js'),
          'indexer-worker': resolve('src/main/indexer-worker.js'),
          'indexer-worker-client': resolve('src/main/indexer-worker-client.js'),
          'recap-capture-query': resolve('src/main/recap-capture-query.js'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [vue()],
  },
});

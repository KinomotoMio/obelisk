#!/usr/bin/env node
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

import { DB_PATH, openDb } from './db.mjs';
import { buildIndex } from './indexer.mjs';
import { createQueryApi, createAttuneApi } from './query.mjs';

function executeScript(api, scriptContent) {
  const sandbox = {
    ...api, JSON, Math, Array, Object, Set, Map, Date, RegExp,
    parseInt, parseFloat, String, Number, Boolean, Error, Promise, console, setTimeout,
  };
  const ctx = vm.createContext(sandbox);
  return vm.runInNewContext(`(async()=>{${scriptContent}})()`, ctx, { timeout: 30000 });
}

function executeQuery(db, scriptContent) {
  return executeScript(createQueryApi(db), scriptContent);
}

function executeAttune(db, scriptContent) {
  return executeScript(createAttuneApi(db), scriptContent);
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--build') {
    buildIndex({ force: true });
    process.stdout.write(JSON.stringify({ ok: true, db: DB_PATH }) + '\n');
    return;
  }
  if (args[0] === '--search' && args[1]) {
    buildIndex();
    const db = openDb();
    process.stdout.write(JSON.stringify(createQueryApi(db).search(args.slice(1).join(' ')), null, 2) + '\n');
    db.close();
    return;
  }
  if (args[0] === '--query' && args[1]) {
    buildIndex();
    const db = openDb();
    const script = fs.readFileSync(path.resolve(args[1]), 'utf8');
    executeQuery(db, script)
      .then(r => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); db.close(); })
      .catch(e => { process.stdout.write(JSON.stringify({ error: e.message, stack: e.stack }) + '\n'); db.close(); process.exitCode = 1; });
    return;
  }
  if (args[0] === '--attune' && args[1]) {
    buildIndex();
    const db = openDb();
    const script = fs.readFileSync(path.resolve(args[1]), 'utf8');
    executeAttune(db, script)
      .then(r => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); db.close(); })
      .catch(e => { process.stdout.write(JSON.stringify({ error: e.message, stack: e.stack }) + '\n'); db.close(); process.exitCode = 1; });
    return;
  }
  process.stderr.write('Usage:\n  node runtime.mjs --build\n  node runtime.mjs --search "text"\n  node runtime.mjs --query <file.js>\n  node runtime.mjs --attune <file.js>\n');
  process.exitCode = 1;
}

main();

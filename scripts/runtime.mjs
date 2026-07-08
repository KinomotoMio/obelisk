#!/usr/bin/env node
// Skill transport: a thin CLI shell over Obelisk Core (scripts/core.ts).
// It only parses args, reads script files, prints JSON, and owns the uniform
// { error, stack } + exit-1 error envelope. All logic lives in Core.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');

import { DB_PATH, buildIndex, searchText, executeQuery, executeAttune } from './core.ts';

async function main() {
  const args = process.argv.slice(2);
  // Uniform error envelope across all four verbs: a failure is reported as
  // { error, stack } on stdout with exit code 1, never a raw crash on stderr.
  const fail = (e) => {
    process.stdout.write(JSON.stringify({ error: e.message, stack: e.stack }) + '\n');
    process.exitCode = 1;
  };
  const emit = (r) => process.stdout.write(JSON.stringify(r, null, 2) + '\n');

  if (args[0] === '--build') {
    try {
      buildIndex({ force: true });
      process.stdout.write(JSON.stringify({ ok: true, db: DB_PATH }) + '\n');
    } catch (e) { fail(e); }
    return;
  }
  if (args[0] === '--search' && args[1]) {
    try { emit(searchText(args.slice(1).join(' '))); } catch (e) { fail(e); }
    return;
  }
  if (args[0] === '--query' && args[1]) {
    try { emit(await executeQuery(fs.readFileSync(path.resolve(args[1]), 'utf8'))); } catch (e) { fail(e); }
    return;
  }
  if (args[0] === '--attune' && args[1]) {
    try { emit(await executeAttune(fs.readFileSync(path.resolve(args[1]), 'utf8'))); } catch (e) { fail(e); }
    return;
  }
  process.stderr.write('Usage:\n  node runtime.mjs --build\n  node runtime.mjs --search "text"\n  node runtime.mjs --query <file.js>\n  node runtime.mjs --attune <file.js>\n');
  process.exitCode = 1;
}

main();

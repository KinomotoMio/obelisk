#!/usr/bin/env node
// Skill transport: a typed thin CLI shell over the Obelisk Core package.
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
  const fail = (e: unknown): void => {
    const error = e instanceof Error ? e : new Error(String(e));
    process.stdout.write(JSON.stringify({ error: error.message, stack: error.stack }) + '\n');
    process.exitCode = 1;
  };
  const emit = (r: unknown): void => {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  };

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
  process.stderr.write('Usage:\n  node runtime.js --build\n  node runtime.js --search "text"\n  node runtime.js --query <file.js>\n  node runtime.js --attune <file.js>\n');
  process.exitCode = 1;
}

main();

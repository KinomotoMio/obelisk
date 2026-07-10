// Regression test for the "cannot rollback - no transaction is active" crash.
// SQLite auto-rolls back certain failures (SQLITE_BUSY, disk full, ...). The
// per-file build loop then ran an explicit ROLLBACK in its catch, which threw a
// SECOND error over the real one and aborted the whole build instead of skipping
// just the bad file. buildIndex now uses a guarded rollback; this test injects a
// DB that faithfully reproduces the condition and asserts the build survives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
import { buildIndex } from '../app/src/main/indexer.ts';
const { DatabaseSync } = require('node:sqlite');

// Wraps node:sqlite and simulates SQLite's auto-rollback-on-error: the first
// write inside a transaction throws a BUSY-like error AND ends the real
// transaction, so a following explicit ROLLBACK errors with "no transaction".
class AutoRollbackOnceDatabase {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.inTxn = false;
    this.fired = false;
  }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) {
    const head = sql.trim().slice(0, 8).toUpperCase();
    if (head.startsWith('BEGIN')) { this.inTxn = true; return this.db.exec('BEGIN'); }
    if (head.startsWith('COMMIT')) { this.inTxn = false; return this.db.exec('COMMIT'); }
    if (head.startsWith('ROLLBACK')) {
      if (!this.inTxn) throw new Error('cannot rollback - no transaction is active');
      this.inTxn = false;
      return this.db.exec('ROLLBACK');
    }
    return this.db.exec(sql);
  }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    const self = this;
    return {
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
      run: (...args) => {
        if (!self.fired && self.inTxn) {
          self.fired = true;
          self.db.exec('ROLLBACK'); // SQLite auto-rolled the txn back on the error
          self.inTxn = false;
          throw new Error('SQLITE_BUSY: database is locked');
        }
        return stmt.run(...args);
      },
    };
  }
  close() { return this.db.close(); }
}

test('a per-file write that auto-rolls-back the transaction is skipped, not fatal', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-rollback-guard-'));
  const projectDir = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(projectDir, { recursive: true });
  const msg = (uuid) => JSON.stringify({
    uuid, type: 'user', timestamp: '2026-06-10T10:00:00Z', cwd: '/tmp/proj',
    message: { role: 'user', content: `hello ${uuid}` },
  }) + '\n';
  writeFileSync(join(projectDir, 'alpha.jsonl'), msg('a1'));
  writeFileSync(join(projectDir, 'beta.jsonl'), msg('b1'));

  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  mkdirSync(join(home, '.obelisk'), { recursive: true });

  // The unguarded ROLLBACK used to make this throw the masking rollback error.
  let result;
  assert.doesNotThrow(() => {
    result = buildIndex({
      force: true,
      claudeDir: join(home, '.claude'),
      codexDir: join(home, '.codex'),
      projectsDir: join(home, '.claude', 'projects'),
      dbPath,
      DatabaseImpl: AutoRollbackOnceDatabase,
    });
  }, 'build must not abort on a transaction-aborting per-file error');

  // Exactly one file's write was poisoned; the other indexed cleanly.
  const check = new DatabaseSync(dbPath);
  const sessions = check.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
  check.close();
  assert.equal(sessions, 1, 'the surviving file is indexed; the poisoned one is skipped');
  assert.ok(result.files >= 2, 'both files were discovered');
});

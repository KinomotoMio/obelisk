// Regression test for the indexer silent-drift fix.
//
// scripts/indexer.mjs and app/indexer.js had diverged in indexJsonl's message
// write: scripts used INSERT OR REPLACE (churns rowid → FTS churn) and always
// carried the previous message_count forward (inflating it on a full re-scan),
// while app used ON CONFLICT DO UPDATE and reset the count when skip===0. app's
// semantics are canonical; this pins them so the two cannot drift again and so
// the Phase 5 provider-adapter merge inherits one known-correct behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexJsonl } from '../scripts/indexer.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = require('node:fs').readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');

function writeSessionJsonl() {
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-drift-'));
  const jsonlPath = join(dir, 'sid-drift.jsonl');
  const lines = [
    { uuid: 'u-1', type: 'user', timestamp: '2026-06-10T10:00:00Z', cwd: '/tmp/proj', message: { role: 'user', content: 'first question' } },
    { uuid: 'a-1', type: 'assistant', timestamp: '2026-06-10T10:00:05Z', message: { role: 'assistant', model: 'claude-opus', content: 'first answer' } },
    { uuid: 'u-2', type: 'user', timestamp: '2026-06-10T10:00:10Z', cwd: '/tmp/proj', message: { role: 'user', content: 'second question' } },
  ];
  writeFileSync(jsonlPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return jsonlPath;
}

test('re-indexing a session upserts messages (stable rowid) and does not inflate message_count', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const fi = { path: writeSessionJsonl(), sessionId: 'sid-drift', project: 'quiet-zero' };

  indexJsonl(db, fi);

  const countAfterFirst = db.prepare('SELECT message_count FROM sessions WHERE id=?').get('sid-drift').message_count;
  const rowidAfterFirst = db.prepare('SELECT rowid FROM messages WHERE uuid=?').get('u-1').rowid;
  const totalMessages = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  assert.equal(countAfterFirst, 3, 'three user/assistant messages counted');
  assert.equal(totalMessages, 3);

  // Simulate a fresh full re-scan (force / lost index_state): skip resets to 0.
  db.prepare('DELETE FROM index_state').run();
  indexJsonl(db, fi);

  const countAfterSecond = db.prepare('SELECT message_count FROM sessions WHERE id=?').get('sid-drift').message_count;
  const rowidAfterSecond = db.prepare('SELECT rowid FROM messages WHERE uuid=?').get('u-1').rowid;
  const totalAfterSecond = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;

  // message_count is reset+recounted, not accumulated (would be 6 under the old bug).
  assert.equal(countAfterSecond, 3, 'message_count must not inflate on re-scan');
  // No duplicate rows.
  assert.equal(totalAfterSecond, 3);
  // Upsert preserves rowid; INSERT OR REPLACE would have churned it.
  assert.equal(rowidAfterSecond, rowidAfterFirst, 'upsert must preserve message rowid (no REPLACE churn)');

  db.close();
});

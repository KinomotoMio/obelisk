// Phase 5b-2a: unit-tests the shared persist layer in isolation (no buildIndex).
// Feeds claude.parse output into persist against an in-memory node:sqlite db and
// asserts rows + the drift-fixed session merge semantics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from '../scripts/providers/claude.ts';
import { persist } from '../scripts/persist.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');

function fixtureUnit() {
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-persist-'));
  const path = join(dir, 'sid-p.jsonl');
  const lines = [
    { type: 'ai-title', aiTitle: 'Persist Session' },
    { uuid: 'u1', type: 'user', timestamp: '2026-06-10T10:00:00Z', cwd: '/proj', message: { role: 'user', content: 'hi' } },
    { uuid: 'a1', type: 'assistant', timestamp: '2026-06-10T10:00:05Z', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'tc1', name: 'Read', input: { file_path: '/f' } }] } },
    { type: 'system', subtype: 'turn_duration', parentUuid: 'a1', durationMs: 999 },
    { uuid: 'u2', type: 'user', timestamp: '2026-06-10T10:00:10Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'body', is_error: false }] } },
    { type: 'system', subtype: 'away_summary', uuid: 's1', timestamp: '2026-06-10T10:00:11Z', content: 'sum' },
  ];
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { key: path, sessionId: 'sid-p', project: 'quiet-zero' };
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

test('persist writes all record kinds from one claude parse', () => {
  const db = freshDb();
  const unit = fixtureUnit();

  const cursor = persist(db, unit, parse(unit, null));

  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages').get().c, 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tool_calls').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tool_results').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM summaries').get().c, 1);

  const ses = db.prepare('SELECT * FROM sessions WHERE id=?').get('sid-p');
  assert.equal(ses.title, 'Persist Session');
  assert.equal(ses.message_count, 3);
  assert.equal(ses.started_at, '2026-06-10T10:00:00Z');
  assert.equal(ses.ended_at, '2026-06-10T10:00:10Z');

  // turn_duration applied via targeted UPDATE.
  assert.equal(db.prepare('SELECT turn_duration_ms FROM messages WHERE uuid=?').get('a1').turn_duration_ms, 999);

  // Cursor persisted into index_state (mtime:lines → two columns).
  const state = db.prepare('SELECT lines_processed FROM index_state WHERE jsonl_path=?').get(unit.key);
  assert.equal(state.lines_processed, 6);
  assert.equal(cursor.split(':')[1], '6');
});

test('resuming from cursor does not double-count message_count', () => {
  const db = freshDb();
  const unit = fixtureUnit();

  const c1 = persist(db, unit, parse(unit, null));
  assert.equal(db.prepare('SELECT message_count m FROM sessions WHERE id=?').get('sid-p').m, 3);

  // Second run resumes at the stored cursor: parse skips all lines, yields an
  // empty-chunk session (count 0); persist accumulates 3 + 0 = 3, not 6.
  persist(db, unit, parse(unit, c1));
  assert.equal(db.prepare('SELECT message_count m FROM sessions WHERE id=?').get('sid-p').m, 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages').get().c, 3);
});

test('fresh full re-scan (no prior cursor) resets message_count instead of accumulating', () => {
  const db = freshDb();
  const unit = fixtureUnit();

  persist(db, unit, parse(unit, null));
  db.prepare('DELETE FROM index_state').run(); // simulate force / lost state
  persist(db, unit, parse(unit, null));

  assert.equal(db.prepare('SELECT message_count m FROM sessions WHERE id=?').get('sid-p').m, 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages').get().c, 3);
});

test('delete-session cascades across tables', () => {
  const db = freshDb();
  const unit = fixtureUnit();
  persist(db, unit, parse(unit, null));

  // Hand-roll a one-shot generator emitting a delete for the session.
  function* del() { yield { kind: 'delete-session', sessionId: 'sid-p' }; return null; }
  persist(db, { key: 'x', sessionId: 'sid-p' }, del());

  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE id=?').get('sid-p').c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages WHERE session_id=?').get('sid-p').c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tool_calls WHERE session_id=?').get('sid-p').c, 0);
});

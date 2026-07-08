// Phase 5b golden test: pins the claude adapter's parse() record stream.
// This is the binding-independent contract — no database is involved. If the
// per-line parse behavior drifts, this fails before persist ever runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from '../scripts/providers/claude.ts';

function writeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-claude-parse-'));
  const path = join(dir, 'sid-x.jsonl');
  const lines = [
    { type: 'ai-title', aiTitle: 'My Session' },
    { uuid: 'u1', type: 'user', timestamp: '2026-06-10T10:00:00Z', cwd: '/proj', gitBranch: 'main', message: { role: 'user', content: 'hi' } },
    { uuid: 'a1', type: 'assistant', timestamp: '2026-06-10T10:00:05Z', message: { role: 'assistant', model: 'claude-opus', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tc1', name: 'Read', input: { file_path: '/f' } }] } },
    { type: 'system', subtype: 'turn_duration', parentUuid: 'a1', durationMs: 1234 },
    { uuid: 'u2', type: 'user', timestamp: '2026-06-10T10:00:10Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'file body', is_error: false }] } },
    { type: 'system', subtype: 'away_summary', uuid: 's1', timestamp: '2026-06-10T10:00:11Z', content: 'a summary' },
  ];
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

// Drain a generator, returning both the yielded values and its return value.
function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) { values.push(step.value); step = gen.next(); }
  return { values, ret: step.value };
}

test('claude parse() yields the expected record stream for a main session', () => {
  const path = writeFixture();
  const { values, ret } = drain(parse({ key: path, sessionId: 'sid-x', project: 'quiet-zero' }, null));

  const byKind = k => values.filter(r => r.kind === k);

  // Three user/assistant messages, correct order and fields.
  assert.deepEqual(byKind('message').map(m => m.uuid), ['u1', 'a1', 'u2']);
  assert.equal(byKind('message').find(m => m.uuid === 'a1').model, 'claude-opus');
  assert.equal(byKind('message').every(m => m.source === 'claude'), true);

  // Tool call + tool result extracted.
  assert.deepEqual(byKind('tool_call').map(t => ({ id: t.id, name: t.name })), [{ id: 'tc1', name: 'Read' }]);
  assert.deepEqual(byKind('tool_result').map(t => ({ id: t.tool_use_id, err: t.is_error })), [{ id: 'tc1', err: 0 }]);

  // turn_duration is an update op keyed on the assistant message.
  assert.deepEqual(byKind('message-turn-duration'), [{ kind: 'message-turn-duration', uuid: 'a1', turn_duration_ms: 1234 }]);

  // Away summary.
  assert.deepEqual(byKind('summary').map(s => s.id), ['s1']);

  // Exactly one session aggregate, reflecting THIS chunk.
  const sessions = byKind('session');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, 'My Session');
  assert.equal(sessions[0].message_count, 3);
  assert.equal(sessions[0].started_at, '2026-06-10T10:00:00Z');
  assert.equal(sessions[0].ended_at, '2026-06-10T10:00:10Z');
  assert.equal(sessions[0].git_branch, 'main');

  // Cursor encodes mtime:lines (6 lines consumed).
  assert.equal(ret, `${statSync(path).mtimeMs}:6`);
});

test('claude parse() emits no session record for a subagent transcript', () => {
  const path = writeFixture();
  const { values } = drain(parse({ key: path, sessionId: 'sid-x', isSubagent: true, agentId: 'agent-7' }, null));

  assert.equal(values.filter(r => r.kind === 'session').length, 0);
  // Subagent messages carry the unit's agent id.
  assert.equal(values.filter(r => r.kind === 'message').every(m => m.agent_id === 'agent-7'), true);
});

test('claude parse() resumes from a cursor, skipping already-indexed lines', () => {
  const path = writeFixture();
  // Cursor with 6 lines already processed → nothing new to parse.
  const { values } = drain(parse({ key: path, sessionId: 'sid-x', project: 'quiet-zero' }, '0:6'));
  // Only the (empty-chunk) session record, with message_count 0.
  assert.deepEqual(values.filter(r => r.kind !== 'session'), []);
  assert.equal(values.find(r => r.kind === 'session').message_count, 0);
});

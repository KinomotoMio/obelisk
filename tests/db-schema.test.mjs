import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { extractContentType, extractMessageIsMeta } from '../packages/core/src/db.ts';

async function readExecutableSchema() {
  return readFile(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
}

async function readSchemaReference() {
  return readFile(new URL('../references/schema.md', import.meta.url), 'utf8');
}

async function readApiReference() {
  return readFile(new URL('../references/api-reference.md', import.meta.url), 'utf8');
}

async function readSkill() {
  return readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
}

test('db module loads the executable schema from scripts/schema.sql', async () => {
  const source = await readFile(new URL('../packages/core/src/db.ts', import.meta.url), 'utf8');

  assert.match(source, /schema\.sql/);
  assert.doesNotMatch(source, /CREATE TABLE IF NOT EXISTS sessions/);
});

test('memories schema indexes common recall filters', async () => {
  const source = await readExecutableSchema();

  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_memories_project ON memories\(project\)/);
  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_memories_session ON memories\(session_id\)/);
  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_memories_created ON memories\(created_at\)/);
  assert.match(source, /CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5/);
  assert.match(source, /CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories/);
  assert.match(source, /CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories/);
  assert.match(source, /CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories/);
});

test('messages schema stores the raw content block type', async () => {
  const source = await readExecutableSchema();

  assert.match(source, /content_type TEXT/);
  assert.match(source, /is_meta INTEGER DEFAULT 0/);
  assert.match(source, /CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages/);
  assert.match(source, /CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages/);
  assert.match(source, /CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages/);
});

test('schema reference stays focused on raw SQL structure', async () => {
  const ref = await readSchemaReference();

  assert.ok(ref.split('\n').length < 420, 'schema.md should remain a quick SQL reference');
  assert.match(ref, /Raw SQL Quick Reference/i);
  assert.match(ref, /references\/api-reference\.md/);
  assert.match(ref, /sessions\.id\s+<--\s+messages\.session_id/);
  assert.match(ref, /tool_calls.*does not have timestamps/i);
  assert.match(ref, /COALESCE\(m\.is_meta, 0\) = 0/);
  assert.doesNotMatch(ref, /#### `summaries\(opts\?\)`/);
  assert.doesNotMatch(ref, /#### `raw\(uuid, opts\?\)`/);
});

test('api reference documents query helpers and current return fields', async () => {
  const ref = await readApiReference();

  assert.match(ref, /## Query API Reference/);
  assert.match(ref, /#### `summaries\(opts\?\)`/);
  assert.match(ref, /summary rows/i);
  assert.match(ref, /session_title/);
  assert.match(ref, /opts\.branch/);
  assert.match(ref, /#### `raw\(uuid, opts\?\)`/);
  assert.match(ref, /original JSONL line/i);
  assert.match(ref, /opts\.offset/);
  assert.match(ref, /totalLength/);
  assert.match(ref, /hasMore/);
  assert.match(ref, /messageCount/);
  assert.doesNotMatch(ref, /a\.messages\.length/);
  assert.doesNotMatch(ref, /Rebuilt on each index pass/);
});

test('skill routes agents to the right reference document', async () => {
  const skill = await readSkill();

  assert.match(skill, /Reference Map/);
  assert.match(skill, /references\/schema\.md.*raw SQL/i);
  assert.match(skill, /references\/api-reference\.md.*helper/i);
  assert.match(skill, /references\/query-patterns\.md.*synthesis/i);
  assert.match(skill, /references\/pitfalls\.md.*error/i);
});

test('extractContentType maps Claude content blocks to the message evidence type', () => {
  assert.equal(extractContentType('hello'), 'text');
  assert.equal(extractContentType([{ type: 'text', text: 'hello' }]), 'text');
  assert.equal(extractContentType([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'text');
  assert.equal(extractContentType([{ type: 'thinking', thinking: 'hidden reasoning' }]), 'thinking');
  assert.equal(extractContentType([{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }]), 'tool_use');
  assert.equal(extractContentType([{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }]), 'tool_result');
  assert.equal(extractContentType([{ type: 'text', text: 'reply' }, { type: 'thinking', thinking: 'hmm' }]), 'unknown');
  assert.equal(extractContentType([{ type: 'text', text: 'reply' }, { type: 'tool_result', content: 'ok' }]), 'unknown');
  assert.equal(extractContentType(null), 'unknown');
});

test('extractMessageIsMeta marks injected and command-envelope messages', () => {
  assert.equal(extractMessageIsMeta({ isMeta: true, message: { content: 'caveat' } }, 'caveat'), 1);
  assert.equal(extractMessageIsMeta({ message: { isMeta: true, content: 'caveat' } }, 'caveat'), 1);
  assert.equal(extractMessageIsMeta(
    { message: { content: [{ type: 'text', text: '<command-name>/exit</command-name>' }] } },
    '<command-name>/exit</command-name>',
  ), 1);
  assert.equal(extractMessageIsMeta(
    { message: { content: [{ type: 'text', text: '<system-reminder>Keep answers concise</system-reminder>' }] } },
    '<system-reminder>Keep answers concise</system-reminder>',
  ), 1);
  assert.equal(extractMessageIsMeta(
    { message: { content: [{ type: 'text', text: '<local-command>git status</local-command>' }] } },
    '<local-command>git status</local-command>',
  ), 1);
  assert.equal(extractMessageIsMeta(
    { message: { content: [{ type: 'text', text: 'quoted <command-name>/exit</command-name>' }] } },
    'quoted <command-name>/exit</command-name>',
  ), 0);
  assert.equal(extractMessageIsMeta({ message: { content: 'normal user request' } }, 'normal user request'), 0);
});

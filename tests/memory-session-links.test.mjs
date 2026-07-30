import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseObeliskSessionHref } from '../app/src/renderer/src/memory-session-links.mjs';

test('parses canonical Obelisk session links without assuming a provider', () => {
  assert.equal(
    parseObeliskSessionHref('obelisk://session/codex%3A019f6392-0dba-7f13-be12-541db3645a69'),
    'codex:019f6392-0dba-7f13-be12-541db3645a69',
  );
  assert.equal(
    parseObeliskSessionHref('obelisk://session/claude-session-id'),
    'claude-session-id',
  );
});

test('rejects malformed or expanded Obelisk session targets', () => {
  assert.equal(parseObeliskSessionHref('https://example.com/session/id'), null);
  assert.equal(parseObeliskSessionHref('obelisk://memory/id'), null);
  assert.equal(parseObeliskSessionHref('obelisk://session/'), null);
  assert.equal(parseObeliskSessionHref('obelisk://session/a/b'), null);
  assert.equal(parseObeliskSessionHref('obelisk://session/id?focus=message'), null);
  assert.equal(parseObeliskSessionHref('obelisk://session/id#message'), null);
  assert.equal(parseObeliskSessionHref('obelisk://user:secret@session/id'), null);
  assert.equal(parseObeliskSessionHref('obelisk://session/id%2Fchild'), null);
});

test('the published skill source documents the canonical link without imposing a section template', () => {
  const skill = readFileSync(new URL('../skill-doc/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /\[descriptive session label\]\(obelisk:\/\/session\/codex%3A/);
  assert.match(skill, /optional provenance aid/);
  assert.match(skill, /not a required section or rigid\s+Memory template/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

test('provider adapters do not change the frozen SQLite schema', () => {
  const schema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url));
  assert.equal(
    createHash('sha256').update(schema).digest('hex'),
    '3e0615ed2db0d7338561df4d51c4240395714c191aa69567ffcdb70efec49826',
  );
});

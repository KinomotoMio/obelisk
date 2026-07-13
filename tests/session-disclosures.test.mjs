import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionDisclosureState } from '../app/src/renderer/src/session-disclosures.mjs';

test('disclosure state survives virtual row unmounts without depending on DOM nodes', () => {
  const disclosures = createSessionDisclosureState();

  disclosures.toggleOpen('tool:call-1', 'message-1');
  disclosures.toggleRaw('tool:call-1', 'message-1');

  assert.equal(disclosures.isOpen('tool:call-1'), true);
  assert.equal(disclosures.isRaw('tool:call-1'), true);

  disclosures.toggleRaw('tool:call-1', 'message-1');
  disclosures.toggleOpen('tool:call-1', 'message-1');

  assert.equal(disclosures.isOpen('tool:call-1'), false);
  assert.equal(disclosures.isRaw('tool:call-1'), false);
});

test('disclosure state forgets entries owned by removed messages', () => {
  const disclosures = createSessionDisclosureState();
  disclosures.toggleOpen('tool:call-1', 'message-1');
  disclosures.toggleOpen('tool:call-2', 'message-2');

  disclosures.retainMessages(new Set(['message-2']));

  assert.equal(disclosures.isOpen('tool:call-1'), false);
  assert.equal(disclosures.isOpen('tool:call-2'), true);
});

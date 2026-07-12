import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createFlapState,
  finishFlap,
  flapSlots,
  requestFlap,
} from '../app/src/renderer/src/flap-number.mjs';

test('flap slots animate only digits that changed', () => {
  assert.deepEqual(flapSlots(822, 823), [
    { from: '8', to: '8', changed: false },
    { from: '2', to: '2', changed: false },
    { from: '2', to: '3', changed: true },
  ]);
});

test('flap state queues rapid updates without interrupting the active flap', () => {
  let state = createFlapState(822);
  state = requestFlap(state, 823);
  state = requestFlap(state, 824);

  assert.equal(state.from, '822');
  assert.equal(state.to, '823');
  assert.equal(state.queued, '824');

  state = finishFlap(state);
  assert.equal(state.from, '823');
  assert.equal(state.to, '824');
  assert.equal(state.animating, true);

  state = finishFlap(state);
  assert.equal(state.settled, '824');
  assert.equal(state.animating, false);
});

test('the latest request clears an older queued value when it matches the active target', () => {
  let state = createFlapState(822);
  state = requestFlap(state, 823);
  state = requestFlap(state, 824);
  state = requestFlap(state, 823);

  assert.equal(state.to, '823');
  assert.equal(state.queued, null);
  state = finishFlap(state);
  assert.equal(state.settled, '823');
  assert.equal(state.animating, false);
});

test('reduced motion updates the settled value immediately', () => {
  const state = requestFlap(createFlapState(822), 823, { reducedMotion: true });

  assert.equal(state.settled, '823');
  assert.equal(state.animating, false);
});

test('queued empty string remains a valid latest value for the generic component', () => {
  let state = createFlapState('1');
  state = requestFlap(state, '2');
  state = requestFlap(state, '');
  state = finishFlap(state);

  assert.equal(state.to, '');
  assert.equal(state.animating, true);
});

test('SessionDetail applies flap motion only to the total message count', () => {
  const source = readFileSync(new URL('../app/src/renderer/src/views/SessionDetail.vue', import.meta.url), 'utf8');

  assert.match(source, /<FlapNumber\s+:value="totalMsgs"/);
  assert.match(source, /msg-nav-current[^>]*>\{\{ currentMsgIdx \+ 1 \}\}/);
});

test('FlapNumber shares one relative geometry and finishes from animationend', () => {
  const source = readFileSync(new URL('../app/src/renderer/src/components/FlapNumber.vue', import.meta.url), 'utf8');

  assert.match(source, /width:\s*1ch/);
  assert.match(source, /height:\s*1lh/);
  assert.match(source, /@animationend\.stop=/);
  assert.doesNotMatch(source, /height:\s*15px/);
  assert.doesNotMatch(source, /setTimeout/);
});

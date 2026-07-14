import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionTimelineScrollPolicy } from '../app/src/renderer/src/session-timeline-scroll-policy.mjs';

test('virtualizer scroll writes are deferred throughout a user scroll', () => {
  let scrolling = true;
  const element = { scrollTop: 100 };
  const writes = [];
  const instance = { scrollElement: element };
  const policy = createSessionTimelineScrollPolicy({
    isUserScrolling: () => scrolling,
    writeScroll: (offset, options) => {
      writes.push({ offset, ...options });
      element.scrollTop = offset + (options.adjustments || 0);
    },
  });

  policy.scrollToFn(100, { behavior: 'auto', adjustments: 24 }, instance);
  policy.scrollToFn(124, { behavior: 'auto' }, instance);
  assert.deepEqual(writes, [], 'momentum is never interrupted by a programmatic write');

  scrolling = false;
  policy.flushDeferredAdjustment(instance);
  assert.deepEqual(writes, [{ offset: 100, behavior: 'auto', adjustments: 24 }]);
  assert.equal(element.scrollTop, 124, 'the accumulated correction restores the reader anchor once');

  policy.flushDeferredAdjustment(instance);
  assert.equal(writes.length, 1, 'settlement is idempotent');
});

test('explicit UUID and pagination navigation can bypass the user-scroll guard', () => {
  const element = { scrollTop: 100 };
  const writes = [];
  const instance = { scrollElement: element };
  const policy = createSessionTimelineScrollPolicy({
    isUserScrolling: () => true,
    writeScroll: (offset, options) => { writes.push({ offset, ...options }); },
  });

  policy.runExplicit(() => {
    policy.scrollToFn(720, { behavior: 'auto' }, instance);
  });

  assert.deepEqual(writes, [{ offset: 720, behavior: 'auto' }]);
});

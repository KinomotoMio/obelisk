import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sessionDetail = readFileSync(
  new URL('../app/src/renderer/src/views/SessionDetail.vue', import.meta.url),
  'utf8',
);
const viewportModule = readFileSync(
  new URL('../app/src/renderer/src/session-timeline-viewport.mjs', import.meta.url),
  'utf8',
);
const appPackage = JSON.parse(readFileSync(
  new URL('../app/package.json', import.meta.url),
  'utf8',
));

test('SessionDetail renders a measured virtual window instead of the complete timeline DOM', () => {
  assert.match(sessionDetail, /useSessionTimelineViewport/);
  assert.match(sessionDetail, /v-for="virtualRow in virtualRows"/);
  assert.match(sessionDetail, /:data-index="virtualRow\.index"/);
  assert.match(sessionDetail, /:ref="measureElement"/);
  assert.doesNotMatch(sessionDetail, /querySelectorAll/);
  assert.doesNotMatch(sessionDetail, /v-memo/);
  assert.doesNotMatch(sessionDetail, /session-view-state/);
  assert.doesNotMatch(sessionDetail, /outerHTML/);
  assert.doesNotMatch(sessionDetail, /closest\(['"]\.msg/);
});

test('timeline viewport owns dynamic measurement, overscan, anchoring, and tail-follow', () => {
  assert.equal(appPackage.devDependencies['@tanstack/vue-virtual'], '^3.13.32');
  assert.match(viewportModule, /useVirtualizer/);
  assert.match(viewportModule, /overscan/);
  assert.match(viewportModule, /anchorTo:\s*'end'/);
  assert.match(viewportModule, /followOnAppend:\s*followOnAppend\.value/);
  assert.match(viewportModule, /resetForInitialSnapshot/);
  assert.match(viewportModule, /completeInitialSnapshot/);
  assert.doesNotMatch(viewportModule, /followOnAppend:\s*true/);
  assert.match(viewportModule, /useAnimationFrameWithResizeObserver:\s*true/);
  assert.match(viewportModule, /scrollPaddingEnd/);
  assert.match(viewportModule, /scrollToIndex/);
  assert.match(viewportModule, /if \(!element\) return/);
});

test('timeline count and disclosure classes come from renderer state rather than DOM state', () => {
  assert.match(sessionDetail, /const totalMsgs = computed\(\(\) => timelineItems\.value\.length\)/);
  assert.match(sessionDetail, /disclosures\.isOpen/);
  assert.match(sessionDetail, /disclosures\.isRaw/);
  assert.doesNotMatch(sessionDetail, /function toggleDisclosure[\s\S]{0,200}classList/);
  assert.doesNotMatch(sessionDetail, /function toggleRaw[\s\S]{0,200}classList/);
  assert.doesNotMatch(sessionDetail, /createSessionDisclosureRegistry/);
});

test('cold startup does not enable append-follow before a real session snapshot exists', () => {
  assert.match(sessionDetail, /if \(!latest\) return/);
  assert.match(sessionDetail, /timelineViewport\.completeInitialSnapshot\(\)/);
});

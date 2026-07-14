import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sessionDetail = readFileSync(
  new URL('../app/src/renderer/src/views/SessionDetail.vue', import.meta.url),
  'utf8',
);
const timelineRow = readFileSync(
  new URL('../app/src/renderer/src/components/SessionTimelineRow.vue', import.meta.url),
  'utf8',
);
const timelinePresentation = readFileSync(
  new URL('../app/src/renderer/src/session-timeline-presentation.mjs', import.meta.url),
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
  assert.match(sessionDetail, /<SessionTimelineRow/);
  assert.match(timelineRow, /buildSessionTimelinePresentation/);
  assert.doesNotMatch(sessionDetail, /renderMarkdown|renderPrettyTool/);
  assert.doesNotMatch(sessionDetail, /querySelectorAll/);
  assert.doesNotMatch(sessionDetail + timelineRow, /v-memo/);
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
  assert.match(timelineRow, /disclosures\.isOpen/);
  assert.match(timelineRow, /disclosures\.isRaw/);
  assert.doesNotMatch(timelineRow, /function toggleDisclosure[\s\S]{0,200}classList/);
  assert.doesNotMatch(timelineRow, /function toggleRaw[\s\S]{0,200}classList/);
  assert.doesNotMatch(sessionDetail, /createSessionDisclosureRegistry/);
});

test('timeline row memoizes derived HTML behind stable content dependencies', () => {
  assert.match(timelineRow, /const presentation = computed/);
  assert.match(timelineRow, /query: props\.query/);
  assert.match(timelineRow, /expandedText: expandedText\.value/);
  assert.match(timelinePresentation, /toolPrettyHtml/);
  assert.match(timelinePresentation, /toolResultHtml/);
  assert.match(timelinePresentation, /renderMarkdown/);
});

test('cold startup does not enable append-follow before a real session snapshot exists', () => {
  assert.match(sessionDetail, /if \(!latest\) return/);
  assert.match(sessionDetail, /timelineViewport\.completeInitialSnapshot\(\)/);
});

test('live patch state advances only after the visible snapshot commit is accepted', () => {
  const loadLiveSnapshot = sessionDetail.match(/async function loadLiveSnapshot\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  const commitLiveSnapshot = sessionDetail.match(/async function commitLiveSnapshot\(snapshot\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.doesNotMatch(loadLiveSnapshot, /clearSessionDirty|acceptMessagePatch/);
  assert.match(
    commitLiveSnapshot,
    /await commitSessionSnapshot\(snapshot\.latest\);[\s\S]*acceptMessagePatch[\s\S]*clearSessionDirty/,
  );
  assert.match(commitLiveSnapshot, /markSessionDirty\(snapshot\.sessionId\)/);
});

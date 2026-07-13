import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  captureSessionViewState,
  findLastMessageAtOrAbove,
  isFollowingSessionTail,
  restoreSessionTail,
  restoreSessionViewState,
} from '../app/src/renderer/src/session-view-state.mjs';

class FakeClassList {
  constructor(classes = []) { this.classes = new Set(classes); }
  add(...classes) { for (const value of classes) this.classes.add(value); }
  contains(value) { return this.classes.has(value); }
}

function disclosure(key, classes = [], { rawOpen = false } = {}) {
  const raw = { classList: new FakeClassList(rawOpen ? ['show'] : []) };
  const pretty = { classList: new FakeClassList() };
  const button = { classList: new FakeClassList() };
  return {
    dataset: { viewKey: key },
    classList: new FakeClassList(classes),
    querySelector(selector) {
      if (selector === '.toolcall-raw') return raw;
      if (selector === '.toolcall-pretty') return pretty;
      if (selector === '.raw-toggle') return button;
      return null;
    },
    raw,
    pretty,
    button,
  };
}

function scrollItem(uuid, top, bottom) {
  return {
    dataset: { uuid },
    getBoundingClientRect: () => ({ top, bottom }),
  };
}

function detail(disclosures, scrollItems) {
  return {
    querySelectorAll(selector) {
      if (selector === '[data-view-key]') return disclosures;
      if (selector === '.msg[data-uuid], .wf-card[data-uuid], .skill-card[data-uuid]') return scrollItems;
      return [];
    },
  };
}

function wrap({ scrollTop, scrollHeight, clientHeight, top = 0 }) {
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    getBoundingClientRect: () => ({ top }),
  };
}

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const signatureEnd = source.indexOf(') {', start);
  assert.notEqual(signatureEnd, -1, `${name} should have a function body`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${name} should have a complete function body`);
}

test('session refresh restores disclosure state and the visible scroll anchor', () => {
  const oldTool = disclosure('tool:call-1', ['open'], { rawOpen: true });
  const oldWrap = wrap({ scrollTop: 500, scrollHeight: 2000, clientHeight: 600 });
  const snapshot = captureSessionViewState({
    wrap: oldWrap,
    detail: detail([oldTool], [scrollItem('msg-1', -20, 180)]),
  });

  const newTool = disclosure('tool:call-1');
  const newWrap = wrap({ scrollTop: 0, scrollHeight: 2200, clientHeight: 600 });
  restoreSessionViewState(snapshot, {
    wrap: newWrap,
    detail: detail([newTool], [scrollItem('msg-1', 80, 280)]),
  });

  assert.equal(newTool.classList.contains('open'), true);
  assert.equal(newTool.raw.classList.contains('show'), true);
  assert.equal(newTool.pretty.classList.contains('hidden'), true);
  assert.equal(newTool.button.classList.contains('active'), true);
  assert.equal(newWrap.scrollTop, 600, '100 px inserted above the anchor is compensated');
});

test('session refresh follows appended content only when already at the tail', () => {
  const oldWrap = wrap({ scrollTop: 1390, scrollHeight: 2000, clientHeight: 600 });
  const snapshot = captureSessionViewState({
    wrap: oldWrap,
    detail: detail([], [scrollItem('msg-last', 300, 590)]),
  });
  const newWrap = wrap({ scrollTop: 0, scrollHeight: 2400, clientHeight: 600 });

  restoreSessionViewState(snapshot, {
    wrap: newWrap,
    detail: detail([], [scrollItem('msg-last', 300, 590)]),
  });

  assert.equal(newWrap.scrollTop, 2400);
});

test('tail-follow detection uses only the scroll container metrics', () => {
  assert.equal(isFollowingSessionTail(wrap({
    scrollTop: 1360,
    scrollHeight: 2000,
    clientHeight: 600,
  })), true);
  assert.equal(isFollowingSessionTail(wrap({
    scrollTop: 1200,
    scrollHeight: 2000,
    clientHeight: 600,
  })), false);
});

test('tail append preserves an active reader and follows only without newer scroll input', () => {
  const reader = wrap({ scrollTop: 600, scrollHeight: 2400, clientHeight: 600 });
  restoreSessionTail({ wrap: reader, followTail: false });
  assert.equal(reader.scrollTop, 600);

  const userMoved = wrap({ scrollTop: 800, scrollHeight: 2400, clientHeight: 600 });
  restoreSessionTail({ wrap: userMoved, followTail: true, restoreScroll: false });
  assert.equal(userMoved.scrollTop, 800);

  const follower = wrap({ scrollTop: 1400, scrollHeight: 2400, clientHeight: 600 });
  restoreSessionTail({ wrap: follower, followTail: true });
  assert.equal(follower.scrollTop, 2400);
});

test('session refresh never restores an old anchor over newer user scrolling', () => {
  const oldTool = disclosure('tool:call-1', ['open']);
  const snapshot = captureSessionViewState({
    wrap: wrap({ scrollTop: 500, scrollHeight: 2000, clientHeight: 600 }),
    detail: detail([oldTool], [scrollItem('msg-1', -20, 180)]),
  });
  const newTool = disclosure('tool:call-1');
  const userScrolledWrap = wrap({ scrollTop: 800, scrollHeight: 2200, clientHeight: 600 });

  restoreSessionViewState(snapshot, {
    wrap: userScrolledWrap,
    detail: detail([newTool], [scrollItem('msg-1', 80, 280)]),
    restoreScroll: false,
  });

  assert.equal(newTool.classList.contains('open'), true, 'disclosure state still restores');
  assert.equal(userScrolledWrap.scrollTop, 800, 'newer user scroll wins over stale refresh state');
});

test('scroll progress locates the visible message without scanning the full session', () => {
  let layoutReads = 0;
  const messages = Array.from({ length: 2048 }, (_, index) => ({
    getBoundingClientRect() {
      layoutReads++;
      return { bottom: (index + 1) * 20 };
    },
  }));

  assert.equal(findLastMessageAtOrAbove(messages, 20100), 1004);
  assert.ok(layoutReads < 20, `expected logarithmic layout reads, got ${layoutReads}`);
});

test('SessionDetail isolates unchanged rows and gives tail appends a scan-free path', () => {
  const source = readFileSync(new URL('../app/src/renderer/src/views/SessionDetail.vue', import.meta.url), 'utf8');
  const dataSource = readFileSync(new URL('../app/src/renderer/src/data.js', import.meta.url), 'utf8');
  const loadMessages = functionSource(source, 'loadMessages');
  const getSkillMd = functionSource(source, 'getSkillMd');

  assert.match(source, /import\s*\{[^}]*shallowRef[^}]*\}\s*from ['"]vue['"]/s);
  assert.match(source, /const messages = shallowRef\(\[\]\)/);
  assert.match(source, /applySnapshot/);
  assert.match(source, /isFollowingSessionTail/);
  assert.match(source, /captureSessionViewState/);
  assert.match(source, /restoreSessionViewState/);
  assert.match(source, /:key="msg\.uuid"\s+v-memo=/);
  assert.match(source, /v-memo="\[msg, state\.query\]"/);
  assert.match(source, /loading\.value\s*=\s*!hadContent/);
  assert.match(source, /scrollRevision/);
  assert.match(source, /restoreScroll:\s*scrollRevision\s*===\s*scrollRevisionBeforePatch/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /findLastMessageAtOrAbove/);
  assert.match(loadMessages, /if \(hadContent && !reconciliation\.tailOnly\)/);
  assert.match(loadMessages, /if \(!reconciliation\.changed\)/);
  assert.ok(
    loadMessages.indexOf('applySnapshot(') < loadMessages.indexOf('captureSessionViewState('),
    'the expensive disclosure and anchor scan happens only after classifying the snapshot',
  );
  assert.ok(
    loadMessages.indexOf('applySnapshot(') < loadMessages.indexOf('isFollowingSessionTail('),
    'tail state is sampled immediately before the patch, after the async snapshot load',
  );
  assert.ok(
    loadMessages.indexOf('isFollowingSessionTail(') < loadMessages.indexOf('messages.value = reconciliation.messages'),
    'tail state is sampled before assigning the new timeline',
  );
  assert.ok(
    loadMessages.indexOf('if (!reconciliation.changed)') < loadMessages.indexOf('await nextTick()'),
    'a no-op snapshot returns before awaiting a timeline patch',
  );
  assert.doesNotMatch(getSkillMd, /messages\.value/);
  assert.match(source, /getSkillMd\(msg\)/);
  assert.match(dataSource, /messages:\s*markRaw\(assembledMessages\)/);
});

test('live totals and scroll position remain isolated across interleaved updates', () => {
  const source = readFileSync(new URL('../app/src/renderer/src/views/SessionDetail.vue', import.meta.url), 'utf8');
  const loadMessages = functionSource(source, 'loadMessages');
  const syncTotalMessages = functionSource(source, 'syncTotalMessages');
  const updateScrollProgress = functionSource(source, 'updateScrollProgress');

  assert.match(loadMessages, /await nextTick\(\);[\s\S]*syncTotalMessages\(\)/);
  assert.match(syncTotalMessages, /totalMsgs\.value\s*=/);
  assert.doesNotMatch(syncTotalMessages, /currentMsgIdx\.value\s*=/);
  assert.match(updateScrollProgress, /currentMsgIdx\.value\s*=/);
  assert.doesNotMatch(updateScrollProgress, /totalMsgs\.value\s*=/);
});

test('message navigation keeps the top progress bar aligned with the current position', () => {
  const source = readFileSync(new URL('../app/src/renderer/src/views/SessionDetail.vue', import.meta.url), 'utf8');
  const setMessagePosition = functionSource(source, 'setMessagePosition');
  const updateScrollProgress = functionSource(source, 'updateScrollProgress');
  const navTo = functionSource(source, 'navTo');

  assert.match(setMessagePosition, /currentMsgIdx\.value\s*=\s*index/);
  assert.match(setMessagePosition, /progressPct\.value\s*=/);
  assert.match(updateScrollProgress, /setMessagePosition\(bottomMsgIdx,\s*msgs\.length\)/);
  assert.match(navTo, /setMessagePosition\(idx,\s*msgs\.length\)/);
});

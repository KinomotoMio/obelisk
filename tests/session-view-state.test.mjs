import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  captureSessionViewState,
  findLastMessageAtOrAbove,
  reconcileSessionMessages,
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

test('message reconciliation preserves existing identities and appends the tail', () => {
  const first = { uuid: 'm1', text: 'old', tool_calls: [{ id: 't1' }] };
  const current = [first];
  const incoming = [
    { uuid: 'm1', text: 'updated', tool_calls: [{ id: 't1', result: { content: 'progress' } }] },
    { uuid: 'm2', text: 'new tail' },
  ];

  const reconciled = reconcileSessionMessages(current, incoming);

  assert.equal(reconciled[0], first);
  assert.equal(reconciled[0].text, 'updated');
  assert.equal(reconciled[0].tool_calls[0].result.content, 'progress');
  assert.equal(reconciled[1], incoming[1]);
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

test('SessionDetail integrates view-state capture and restore into live reloads', () => {
  const source = readFileSync(new URL('../app/src/renderer/src/views/SessionDetail.vue', import.meta.url), 'utf8');

  assert.match(source, /captureSessionViewState/);
  assert.match(source, /reconcileSessionMessages/);
  assert.match(source, /restoreSessionViewState/);
  assert.match(source, /loading\.value\s*=\s*!hadContent/);
  assert.match(source, /scrollRevision/);
  assert.match(source, /restoreScroll:\s*scrollRevision\s*===\s*scrollRevisionAtLoad/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /findLastMessageAtOrAbove/);
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

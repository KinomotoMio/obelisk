const DISCLOSURE_CLASSES = ['open', 'skill-md-open'];
const SCROLL_ITEM_SELECTOR = '.msg[data-uuid], .wf-card[data-uuid], .skill-card[data-uuid]';

function arrayFrom(value) {
  return value ? Array.from(value) : [];
}

function scrollItems(detail) {
  return arrayFrom(detail?.querySelectorAll?.(SCROLL_ITEM_SELECTOR));
}

export function createSessionDomIndex(detail) {
  const items = scrollItems(detail);
  const byUuid = new Map();
  const byMessageUuid = new Map();
  for (const item of items) {
    const uuid = item.dataset?.uuid;
    const messageUuid = item.dataset?.messageUuid || uuid;
    if (uuid) byUuid.set(uuid, item);
    if (!messageUuid) continue;
    const roots = byMessageUuid.get(messageUuid) || [];
    roots.push(item);
    byMessageUuid.set(messageUuid, roots);
  }
  return { items, byUuid, byMessageUuid };
}

function applyDisclosureState(element, state) {
  element.classList?.add(...state.classes);
  if (!state.rawOpen) return;
  element.querySelector?.('.toolcall-raw')?.classList?.add('show');
  element.querySelector?.('.toolcall-pretty')?.classList?.add('hidden');
  element.querySelector?.('.raw-toggle')?.classList?.add('active');
}

function viewElements(root) {
  const elements = [];
  if (root?.matches?.('[data-view-key]')) elements.push(root);
  elements.push(...arrayFrom(root?.querySelectorAll?.('[data-view-key]')));
  return elements;
}

export function createSessionDisclosureRegistry() {
  const states = new Map();
  return {
    remember(element) {
      const key = element?.dataset?.viewKey;
      if (!key) return;
      const messageRoot = element.closest?.('[data-message-uuid]');
      const messageUuid = messageRoot?.dataset?.messageUuid;
      if (!messageUuid) return;
      const classes = DISCLOSURE_CLASSES.filter(className => element.classList?.contains(className));
      const rawOpen = Boolean(element.querySelector?.('.toolcall-raw')?.classList?.contains('show'));
      if (!classes.length && !rawOpen) {
        states.delete(key);
        return;
      }
      states.set(key, { messageUuid, classes, rawOpen });
    },
    reconcile(domIndex, { updatedIds = [], removedIds = [] } = {}) {
      const removed = new Set(removedIds);
      for (const [key, state] of states) {
        if (removed.has(state.messageUuid)) states.delete(key);
      }
      for (const messageUuid of updatedIds) {
        for (const root of domIndex?.byMessageUuid?.get(messageUuid) || []) {
          for (const element of viewElements(root)) {
            const state = states.get(element.dataset?.viewKey);
            if (state?.messageUuid === messageUuid) applyDisclosureState(element, state);
          }
        }
      }
    },
  };
}

export function isFollowingSessionTail(wrap, bottomThreshold = 50) {
  if (!wrap) return false;
  return wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < bottomThreshold;
}

export function restoreSessionTail({ wrap, followTail, restoreScroll = true } = {}) {
  if (!wrap || !followTail || !restoreScroll) return;
  wrap.scrollTop = wrap.scrollHeight;
}

function firstMessageEndingBelowIndex(messages, line) {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (messages[middle].getBoundingClientRect().bottom > line) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

export function captureSessionViewState({ wrap, domIndex, bottomThreshold = 50 } = {}) {
  if (!wrap) return null;
  const followTail = isFollowingSessionTail(wrap, bottomThreshold);
  const wrapTop = wrap.getBoundingClientRect?.().top || 0;
  const anchorIndex = followTail
    ? -1
    : firstMessageEndingBelowIndex(domIndex?.items || [], wrapTop);
  const anchorElement = followTail
    ? null
    : domIndex?.items?.[anchorIndex];

  return {
    followTail,
    scrollTop: wrap.scrollTop,
    anchor: anchorElement?.dataset?.uuid
      ? {
          uuid: anchorElement.dataset.uuid,
          messageUuid: anchorElement.dataset.messageUuid || anchorElement.dataset.uuid,
          offset: anchorElement.getBoundingClientRect().top - wrapTop,
        }
      : null,
  };
}

export function restoreSessionViewState(snapshot, { wrap, domIndex, restoreScroll = true } = {}) {
  if (!snapshot || !wrap) return;

  if (!restoreScroll) return;

  if (snapshot.followTail) {
    restoreSessionTail({ wrap, followTail: true });
    return;
  }

  wrap.scrollTop = snapshot.scrollTop;
  if (!snapshot.anchor) return;
  const wrapTop = wrap.getBoundingClientRect?.().top || 0;
  const anchorElement = domIndex?.byUuid?.get(snapshot.anchor.uuid)
    || domIndex?.byMessageUuid?.get(snapshot.anchor.messageUuid)?.[0];
  if (!anchorElement) return;
  const currentOffset = anchorElement.getBoundingClientRect().top - wrapTop;
  wrap.scrollTop += currentOffset - snapshot.anchor.offset;
}

export function findLastMessageAtOrAbove(messages, bottomLine) {
  if (!messages?.length) return -1;
  return Math.max(0, firstMessageEndingBelowIndex(messages, bottomLine) - 1);
}

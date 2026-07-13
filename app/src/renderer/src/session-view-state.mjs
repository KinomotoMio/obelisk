const DISCLOSURE_CLASSES = ['open', 'skill-md-open'];
const SCROLL_ITEM_SELECTOR = '.msg[data-uuid], .wf-card[data-uuid], .skill-card[data-uuid]';

function arrayFrom(value) {
  return value ? Array.from(value) : [];
}

function scrollItems(detail) {
  return arrayFrom(detail?.querySelectorAll?.(SCROLL_ITEM_SELECTOR));
}

export function isFollowingSessionTail(wrap, bottomThreshold = 50) {
  if (!wrap) return false;
  return wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < bottomThreshold;
}

export function restoreSessionTail({ wrap, followTail, restoreScroll = true } = {}) {
  if (!wrap || !followTail || !restoreScroll) return;
  wrap.scrollTop = wrap.scrollHeight;
}

export function captureSessionViewState({ wrap, detail, bottomThreshold = 50 } = {}) {
  if (!wrap) return null;
  const followTail = isFollowingSessionTail(wrap, bottomThreshold);
  const wrapTop = wrap.getBoundingClientRect?.().top || 0;
  const anchorElement = followTail
    ? null
    : scrollItems(detail).find(element => element.getBoundingClientRect().bottom > wrapTop);

  const disclosures = [];
  for (const element of arrayFrom(detail?.querySelectorAll?.('[data-view-key]'))) {
    const key = element.dataset?.viewKey;
    if (!key) continue;
    const classes = DISCLOSURE_CLASSES.filter(className => element.classList?.contains(className));
    const rawOpen = Boolean(element.querySelector?.('.toolcall-raw')?.classList?.contains('show'));
    if (classes.length || rawOpen) disclosures.push({ key, classes, rawOpen });
  }

  return {
    followTail,
    scrollTop: wrap.scrollTop,
    anchor: anchorElement?.dataset?.uuid
      ? {
          uuid: anchorElement.dataset.uuid,
          offset: anchorElement.getBoundingClientRect().top - wrapTop,
        }
      : null,
    disclosures,
  };
}

export function restoreSessionViewState(snapshot, { wrap, detail, restoreScroll = true } = {}) {
  if (!snapshot || !wrap) return;

  const disclosuresByKey = new Map(
    arrayFrom(detail?.querySelectorAll?.('[data-view-key]'))
      .filter(element => element.dataset?.viewKey)
      .map(element => [element.dataset.viewKey, element]),
  );

  for (const disclosure of snapshot.disclosures || []) {
    const element = disclosuresByKey.get(disclosure.key);
    if (!element) continue;
    element.classList?.add(...disclosure.classes);
    if (!disclosure.rawOpen) continue;
    element.querySelector?.('.toolcall-raw')?.classList?.add('show');
    element.querySelector?.('.toolcall-pretty')?.classList?.add('hidden');
    element.querySelector?.('.raw-toggle')?.classList?.add('active');
  }

  if (!restoreScroll) return;

  if (snapshot.followTail) {
    restoreSessionTail({ wrap, followTail: true });
    return;
  }

  wrap.scrollTop = snapshot.scrollTop;
  if (!snapshot.anchor) return;
  const wrapTop = wrap.getBoundingClientRect?.().top || 0;
  const anchorElement = scrollItems(detail).find(
    element => element.dataset?.uuid === snapshot.anchor.uuid,
  );
  if (!anchorElement) return;
  const currentOffset = anchorElement.getBoundingClientRect().top - wrapTop;
  wrap.scrollTop += currentOffset - snapshot.anchor.offset;
}

export function findLastMessageAtOrAbove(messages, bottomLine) {
  if (!messages?.length) return -1;
  let low = 0;
  let high = messages.length - 1;
  let result = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (messages[middle].getBoundingClientRect().bottom <= bottomLine) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

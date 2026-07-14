export function createSessionTimelineScrollPolicy({ isUserScrolling, writeScroll }) {
  let explicitDepth = 0;
  let deferredAdjustment = 0;
  let deferredInstance = null;

  function scrollToFn(offset, options = {}, instance) {
    if (explicitDepth === 0 && isUserScrolling()) {
      const adjustment = Number(options.adjustments);
      if (Number.isFinite(adjustment)) deferredAdjustment += adjustment;
      deferredInstance = instance;
      return;
    }
    writeScroll(offset, options, instance);
  }

  function runExplicit(action) {
    explicitDepth++;
    try {
      return action();
    } finally {
      explicitDepth--;
    }
  }

  function flushDeferredAdjustment(instance = deferredInstance) {
    if (isUserScrolling() || deferredAdjustment === 0 || !instance?.scrollElement) return false;
    const adjustment = deferredAdjustment;
    deferredAdjustment = 0;
    deferredInstance = null;
    const offset = Number(instance.scrollElement.scrollTop) || 0;
    writeScroll(offset, { behavior: 'auto', adjustments: adjustment }, instance);
    return true;
  }

  return {
    scrollToFn,
    runExplicit,
    flushDeferredAdjustment,
  };
}

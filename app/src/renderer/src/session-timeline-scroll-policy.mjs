export function createSessionTimelineScrollPolicy({ isUserScrolling, writeScroll }) {
  let explicitDepth = 0;

  function scrollToFn(offset, options = {}, instance) {
    if (explicitDepth === 0 && isUserScrolling()) {
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

  return {
    scrollToFn,
    runExplicit,
  };
}

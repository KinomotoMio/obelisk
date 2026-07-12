function normalizeFlapValue(value) {
  return String(value ?? '');
}

export function createFlapState(value) {
  const settled = normalizeFlapValue(value);
  return {
    settled,
    from: settled,
    to: settled,
    animating: false,
    queued: null,
    version: 0,
  };
}

export function requestFlap(state, value, { reducedMotion = false } = {}) {
  const next = normalizeFlapValue(value);
  if (reducedMotion) return createFlapState(next);
  if (state.animating) {
    if (next === state.to) return { ...state, queued: null };
    return { ...state, queued: next };
  }
  if (next === state.settled) return state;
  return {
    ...state,
    from: state.settled,
    to: next,
    animating: true,
    queued: null,
    version: state.version + 1,
  };
}

export function finishFlap(state) {
  if (!state.animating) return state;
  const settled = state.to;
  const queued = state.queued;
  const stable = {
    ...state,
    settled,
    from: settled,
    to: settled,
    animating: false,
    queued: null,
  };
  return queued !== null && queued !== settled ? requestFlap(stable, queued) : stable;
}

export function flapSlots(fromValue, toValue) {
  const from = normalizeFlapValue(fromValue);
  const to = normalizeFlapValue(toValue);
  const width = Math.max(from.length, to.length);
  const oldText = from.padStart(width, ' ');
  const newText = to.padStart(width, ' ');
  return Array.from({ length: width }, (_, index) => ({
    from: oldText[index],
    to: newText[index],
    changed: oldText[index] !== newText[index],
  }));
}

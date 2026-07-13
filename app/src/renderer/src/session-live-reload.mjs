export function createSessionLiveReloadCoordinator({ isScrolling, load, commit }) {
  let pending = false;
  let loadedSnapshot = null;
  let inFlight = null;
  let stopped = false;

  async function drain() {
    while (!stopped && !isScrolling() && (pending || loadedSnapshot)) {
      let snapshot = loadedSnapshot;
      loadedSnapshot = null;

      if (pending) {
        pending = false;
        snapshot = await load();
      }
      if (stopped) return;

      // Scrolling may start while IPC is loading the snapshot. Keep the loaded
      // value, but do not patch the visible timeline until scrolling settles.
      if (isScrolling()) {
        loadedSnapshot = snapshot;
        return;
      }

      // A newer update arrived while this snapshot loaded. Skip the stale
      // intermediate commit and loop once more for the latest snapshot.
      if (pending) continue;
      if (snapshot !== null && snapshot !== undefined) await commit(snapshot);
    }
  }

  async function flush() {
    if (stopped || isScrolling() || (!pending && !loadedSnapshot)) return inFlight;
    if (inFlight) return inFlight;
    inFlight = drain();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
    if ((pending || loadedSnapshot) && !isScrolling()) return flush();
    return undefined;
  }

  return {
    request() {
      if (stopped) return Promise.resolve();
      pending = true;
      return flush();
    },
    flush,
    stop() {
      stopped = true;
      pending = false;
      loadedSnapshot = null;
    },
  };
}

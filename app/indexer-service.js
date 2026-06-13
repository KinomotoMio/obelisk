const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_STABILITY_MS = 500;
const DEFAULT_HEARTBEAT_MS = 30000;
const DEFAULT_WATCH_RETRY_MS = 5000;

function createIndexerService({
  projectsDir = DEFAULT_PROJECTS_DIR,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  stabilityMs = DEFAULT_STABILITY_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  watchRetryMs = DEFAULT_WATCH_RETRY_MS,
  buildIndex,
  writeHeartbeat = () => {},
  watchProjects,
  chokidar,
  timers = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  },
  logger = console,
} = {}) {
  if (typeof buildIndex !== 'function') throw new Error('createIndexerService() requires buildIndex');
  const watch = watchProjects || ((onChange) => {
    if (!fs.existsSync(projectsDir)) return null;
    const watcher = (chokidar || require('chokidar')).watch(projectsDir, {
      cwd: projectsDir,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: Math.max(stabilityMs, 500),
        pollInterval: 100,
      },
      ignored: (targetPath, stats) => {
        if (stats?.isDirectory()) return false;
        if (!stats) return false;
        return !String(targetPath).endsWith('.jsonl') && !String(targetPath).endsWith('.json');
      },
    });
    const onFileChange = (filename) => {
      const name = filename ? String(filename) : '';
      if (!name || name.endsWith('.jsonl') || name.endsWith('.json')) onChange(name);
    };
    return watcher
      .on('add', onFileChange)
      .on('change', onFileChange)
      .on('unlink', onFileChange)
      .on('error', (error) => {
        logger.warn?.(`Obelisk watcher failed: ${error.message}`);
      });
  });

  let buildTimer = null;
  let stabilityTimer = null;
  let heartbeatTimer = null;
  let watchRetryTimer = null;
  let watcher = null;
  let stopped = false;
  let running = false;
  let pending = false;
  let lastReason = null;
  let changedPaths = new Set();
  let idlePromise = Promise.resolve();

  const addChangedPath = (changedPath) => {
    if (Array.isArray(changedPath)) {
      for (const p of changedPath) addChangedPath(p);
      return;
    }
    const name = changedPath ? String(changedPath) : '';
    if (name) changedPaths.add(name);
  };

  const takeChangedPaths = () => {
    if (!changedPaths.size) return undefined;
    const paths = [...changedPaths];
    changedPaths = new Set();
    return paths;
  };

  const runBuildNow = (reason = 'manual', paths = undefined) => {
    addChangedPath(paths);
    if (stopped) return idlePromise;
    if (running) {
      pending = true;
      return idlePromise;
    }
    running = true;
    pending = false;
    const buildChangedPaths = takeChangedPaths();
    idlePromise = (async () => {
      await buildIndex({ reason, changedPaths: buildChangedPaths });
      writeHeartbeat();
    })()
      .catch((error) => {
        logger.warn?.(`Obelisk index build failed: ${error.message}`);
      })
      .finally(() => {
        running = false;
        if (pending && !stopped) {
          pending = false;
          runBuildNow('pending');
        }
      });
    return idlePromise;
  };

  const scheduleBuild = (reason = 'change', changedPath = undefined) => {
    if (stopped) return;
    addChangedPath(changedPath);
    lastReason = reason;
    if (running) pending = true;
    if (buildTimer) timers.clearTimeout(buildTimer);
    if (stabilityTimer) timers.clearTimeout(stabilityTimer);
    buildTimer = timers.setTimeout(() => {
      buildTimer = null;
      if (stabilityMs <= 0) {
        runBuildNow(lastReason || reason);
        return;
      }
      stabilityTimer = timers.setTimeout(() => {
        stabilityTimer = null;
        runBuildNow(lastReason || reason);
      }, stabilityMs);
    }, debounceMs);
  };

  const startWatching = () => {
    if (stopped || watcher) return;
    watcher = watch((changedPath) => scheduleBuild('watch', changedPath));
    if (!watcher) {
      watchRetryTimer = timers.setTimeout(() => {
        watchRetryTimer = null;
        startWatching();
      }, watchRetryMs);
    }
  };

  const start = ({ buildOnStart = true } = {}) => {
    stopped = false;
    if (buildOnStart) scheduleBuild('startup');
    startWatching();
    if (typeof timers.setInterval === 'function') {
      heartbeatTimer = timers.setInterval(() => {
        try {
          writeHeartbeat();
        } catch (error) {
          logger.warn?.(`Obelisk heartbeat failed: ${error.message}`);
        }
      }, heartbeatMs);
    }
  };

  const stop = () => {
    stopped = true;
    pending = false;
    if (buildTimer) timers.clearTimeout(buildTimer);
    buildTimer = null;
    if (stabilityTimer) timers.clearTimeout(stabilityTimer);
    stabilityTimer = null;
    if (watchRetryTimer) timers.clearTimeout(watchRetryTimer);
    watchRetryTimer = null;
    if (heartbeatTimer && typeof timers.clearInterval === 'function') timers.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (watcher?.close) watcher.close();
    watcher = null;
  };

  return {
    start,
    stop,
    scheduleBuild,
    runBuildNow,
    idle: () => idlePromise,
  };
}

module.exports = { createIndexerService };

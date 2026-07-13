import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionLiveReloadCoordinator } from '../app/src/renderer/src/session-live-reload.mjs';

test('live snapshots coalesce while scrolling and commit once after scroll end', async () => {
  let scrolling = true;
  let loads = 0;
  const commits = [];
  const coordinator = createSessionLiveReloadCoordinator({
    isScrolling: () => scrolling,
    load: async () => ++loads,
    commit: async snapshot => { commits.push(snapshot); },
  });

  await coordinator.request();
  await coordinator.request();
  await coordinator.request();
  assert.equal(loads, 0);
  assert.deepEqual(commits, []);

  scrolling = false;
  await coordinator.flush();
  assert.equal(loads, 1);
  assert.deepEqual(commits, [1]);

  await coordinator.flush();
  assert.equal(loads, 1, 'an idle flush without another update is a no-op');
});

test('an update arriving during an in-flight load skips the stale snapshot without overlap', async () => {
  let releaseFirstLoad;
  let activeLoads = 0;
  let maxActiveLoads = 0;
  let loads = 0;
  const commits = [];
  const firstLoadGate = new Promise(resolve => { releaseFirstLoad = resolve; });
  const coordinator = createSessionLiveReloadCoordinator({
    isScrolling: () => false,
    load: async () => {
      loads++;
      activeLoads++;
      maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
      if (loads === 1) await firstLoadGate;
      activeLoads--;
      return loads;
    },
    commit: async snapshot => { commits.push(snapshot); },
  });

  const first = coordinator.request();
  const second = coordinator.request();
  releaseFirstLoad();
  await Promise.all([first, second]);

  assert.equal(loads, 2);
  assert.equal(maxActiveLoads, 1, 'snapshot loads remain serialized');
  assert.deepEqual(commits, [2], 'only the freshest loaded snapshot is committed');
});

test('scrolling that starts during IPC defers the loaded snapshot commit', async () => {
  let scrolling = false;
  let releaseLoad;
  let loads = 0;
  const commits = [];
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  const coordinator = createSessionLiveReloadCoordinator({
    isScrolling: () => scrolling,
    load: async () => {
      loads++;
      await loadGate;
      return 'loaded-before-scroll-ended';
    },
    commit: async snapshot => { commits.push(snapshot); },
  });

  const request = coordinator.request();
  scrolling = true;
  releaseLoad();
  await request;

  assert.equal(loads, 1);
  assert.deepEqual(commits, []);

  scrolling = false;
  await coordinator.flush();
  assert.equal(loads, 1, 'the already-loaded snapshot is reused');
  assert.deepEqual(commits, ['loaded-before-scroll-ended']);
});

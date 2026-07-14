// Production renderer integration test for the dynamic SessionDetail timeline.
// Run: npm run test:electron:timeline
import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSessionPatch } from '../src/shared/session-patch.mjs';
import { assembleSessionMessages } from '../src/shared/session-detail-assembly.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const sessionId = 'test-session';
const messageCount = Number(process.env.OBELISK_TIMELINE_MESSAGE_COUNT || 2000);
const focusMessageIndex = Math.floor(messageCount * 0.75);
const focusMessageUuid = `message-${focusMessageIndex}`;
const stationaryAppendRuns = 3;
const firstStationaryAppendIndex = messageCount;
const scrollingAppendIndex = messageCount + stationaryAppendRuns;
const nearTailEscapeAppendIndex = scrollingAppendIndex + 1;
const tailAppendIndex = nearTailEscapeAppendIndex + 1;
const channels = [
  'db:getSessions',
  'db:getSessionMessages',
  'db:getSessionToolCalls',
  'db:getSessionToolResults',
  'db:getSessionPatch',
  'db:getSessionSubagents',
  'db:getSessionWorkflows',
  'db:getSessionSummaries',
  'db:getMessageFullText',
  'db:getMemories',
  'db:getProjects',
  'db:getStats',
  'settings:get',
];

let failures = 0;
let firstSessionListRead = true;
const ipcReads = {
  messages: 0,
  toolCalls: 0,
  toolResults: 0,
  subagents: 0,
  workflows: 0,
  summaries: 0,
  patches: 0,
  patchMessageRows: [],
};
const messages = Array.from({ length: messageCount }, (_, index) => ({
  uuid: `message-${index}`,
  type: index % 2 === 0 ? 'user' : 'assistant',
  timestamp: new Date(Date.UTC(2026, 6, 14, 0, 0, index)).toISOString(),
  text: index === 1
    ? ''
    : `Message ${index} ${'dynamic-height content '.repeat((index % 7) + 1)}`,
  content_type: index === 1 ? 'tool_use' : 'text',
  is_meta: 0,
}));
messages[focusMessageIndex].type = 'assistant';
messages[focusMessageIndex].text = `Truncated preview ${'indexed content '.repeat(700)}`;
const fullTextSentinel = `FULL TEXT SENTINEL ${'complete content '.repeat(80)}`;
const codexExecSource = 'const result = { ok: true };\nreturn result;';
let codexExecOutput = JSON.stringify([{
  type: 'input_text',
  text: 'Script completed\nWall time 0.1 seconds\nOutput:\n{"ok":true}',
}]);
const toolCalls = [{
  id: 'call-1',
  message_uuid: 'message-1',
  name: 'Bash',
  input_json: JSON.stringify({ command: 'printf virtualized' }),
}, {
  id: 'call-codex-exec',
  message_uuid: focusMessageUuid,
  name: 'exec',
  input_json: JSON.stringify(codexExecSource),
}];
const toolResults = [{
  tool_use_id: 'call-1',
  content: `${'virtualized output\n'.repeat(80)}`,
  is_error: 0,
}, {
  tool_use_id: 'call-codex-exec',
  content: codexExecOutput,
  is_error: 0,
}];

function sessionSummary() {
  return {
    id: sessionId,
    title: 'Virtualized timeline integration',
    project: 'quiet-zero',
    project_path: '/tmp/quiet-zero',
    source: 'claude',
    started_at: '2026-07-14T00:00:00.000Z',
    ended_at: '2026-07-14T01:00:00.000Z',
    message_count: messages.length,
    git_branch: 'main',
  };
}

function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else {
    failures++;
    console.error(`FAIL: ${message}`);
  }
}

async function waitFor(webContents, expression, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await webContents.executeJavaScript(`Boolean(${expression})`, true)) return;
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function startRendererTrace(win) {
  const traceEvents = [];
  let completeTrace;
  const traceComplete = new Promise(resolve => { completeTrace = resolve; });
  const onMessage = (_event, method, params = {}) => {
    if (method === 'Tracing.dataCollected') traceEvents.push(...(params.value || []));
    if (method === 'Tracing.tracingComplete') completeTrace();
  };
  win.webContents.debugger.attach('1.3');
  win.webContents.debugger.on('message', onMessage);
  await win.webContents.debugger.sendCommand('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,toplevel',
    options: 'record-as-much-as-possible',
    transferMode: 'ReportEvents',
  });
  return async () => {
    await win.webContents.debugger.sendCommand('Tracing.end');
    await traceComplete;
    win.webContents.debugger.removeListener('message', onMessage);
    win.webContents.debugger.detach();
    return traceEvents;
  };
}

function rendererTaskMetrics(traceEvents, startMark, endMark) {
  const start = traceEvents.find(event => event.name === startMark);
  const end = [...traceEvents].reverse().find(event => event.name === endMark);
  if (!start || !end) throw new Error(`Missing renderer trace marks: ${startMark}, ${endMark}`);
  const tasks = traceEvents
    .filter(event => (
      /RunTask$/.test(event.name || '')
      && event.ph === 'X'
      && event.pid === start.pid
      && event.tid === start.tid
      && event.ts >= start.ts
      && event.ts <= end.ts
    ));
  const taskDurations = tasks.map(event => event.dur / 1000);
  if (taskDurations.length === 0) throw new Error('Renderer trace contained no RunTask events');
  const slowest = tasks.reduce((best, task) => !best || task.dur > best.dur ? task : best, null);
  const slowestChildren = slowest
    ? traceEvents
      .filter(event => (
        event.ph === 'X'
        && event.pid === slowest.pid
        && event.tid === slowest.tid
        && event !== slowest
        && event.ts >= slowest.ts
        && event.ts + (event.dur || 0) <= slowest.ts + slowest.dur
      ))
      .sort((a, b) => (b.dur || 0) - (a.dur || 0))
      .slice(0, 8)
      .map(event => ({ name: event.name, durationMs: (event.dur || 0) / 1000 }))
    : [];
  return {
    tasks: taskDurations.length,
    maxTaskMs: Math.max(0, ...taskDurations),
    slowestChildren,
  };
}

async function traceStationaryAppend(win, index, expectedTotal, runIndex) {
  const startMark = `obelisk-live-commit-${runIndex}-start`;
  const endMark = `obelisk-live-commit-${runIndex}-end`;
  const stopRendererTrace = await startRendererTrace(win);
  await win.webContents.executeJavaScript(`(() => {
    const expected = ${JSON.stringify(String(expectedTotal))};
    const counter = document.querySelector('.flap-number');
    performance.mark(${JSON.stringify(startMark)});
    window.__obeliskLiveCommitObserved = new Promise(resolve => {
      const finish = () => requestAnimationFrame(() => {
        performance.mark(${JSON.stringify(endMark)});
        resolve(true);
      });
      if (counter?.getAttribute('aria-label') === expected) {
        finish();
        return;
      }
      const observer = new MutationObserver(() => {
        if (counter?.getAttribute('aria-label') !== expected) return;
        observer.disconnect();
        finish();
      });
      observer.observe(counter, { attributes: true, attributeFilter: ['aria-label'] });
    });
    return true;
  })()`, true);
  appendMessage(win, index);
  await win.webContents.executeJavaScript('window.__obeliskLiveCommitObserved', true);
  await win.webContents.executeJavaScript('delete window.__obeliskLiveCommitObserved', true);
  return rendererTaskMetrics(await stopRendererTrace(), startMark, endMark);
}

function registerHandlers() {
  ipcMain.handle('db:getSessions', async () => {
    if (firstSessionListRead) {
      firstSessionListRead = false;
      await delay(120);
    }
    return [sessionSummary()];
  });
  ipcMain.handle('db:getSessionMessages', () => { ipcReads.messages++; return messages; });
  ipcMain.handle('db:getSessionToolCalls', () => { ipcReads.toolCalls++; return toolCalls; });
  ipcMain.handle('db:getSessionToolResults', () => { ipcReads.toolResults++; return toolResults; });
  ipcMain.handle('db:getSessionPatch', (_event, _sessionId, cursor) => {
    ipcReads.patches++;
    const patch = createSessionPatch({
      messages: assembleSessionMessages({ messages, toolCalls, toolResults, subagents: [], workflows: [] }),
      workflows: [],
    }, cursor);
    ipcReads.patchMessageRows.push(patch.changes.messages.length);
    return patch;
  });
  ipcMain.handle('db:getSessionSubagents', () => { ipcReads.subagents++; return []; });
  ipcMain.handle('db:getSessionWorkflows', () => { ipcReads.workflows++; return []; });
  ipcMain.handle('db:getSessionSummaries', () => { ipcReads.summaries++; return []; });
  ipcMain.handle('db:getMessageFullText', (_event, uuid) => uuid === focusMessageUuid ? fullTextSentinel : null);
  ipcMain.handle('db:getMemories', () => []);
  ipcMain.handle('db:getProjects', () => [{ project: 'quiet-zero', count: 1 }]);
  ipcMain.handle('db:getStats', () => ({}));
  ipcMain.handle('settings:get', () => ({}));
}

function appendMessage(win, index) {
  messages.push({
    uuid: `message-${index}`,
    type: index % 2 === 0 ? 'user' : 'assistant',
    timestamp: new Date().toISOString(),
    text: `Live message ${index}`,
    content_type: 'text',
    is_meta: 0,
  });
  win.webContents.send('obelisk:session-updated', { sessionId });
}

function replaceMessageText(win, uuid, text) {
  const index = messages.findIndex(message => message.uuid === uuid);
  if (index < 0) throw new Error(`Cannot update missing message ${uuid}`);
  messages[index] = { ...messages[index], text };
  win.webContents.send('obelisk:session-updated', { sessionId });
}

function replaceToolResult(win, toolUseId, content) {
  const index = toolResults.findIndex(result => result.tool_use_id === toolUseId);
  if (index < 0) throw new Error(`Cannot update missing tool result ${toolUseId}`);
  toolResults[index] = { ...toolResults[index], content };
  win.webContents.send('obelisk:session-updated', { sessionId });
}

async function run() {
  registerHandlers();
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(appRoot, 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadFile(join(appRoot, 'out', 'renderer', 'index.html'), {
    hash: `/sessions/${sessionId}`,
  });
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${messageCount}'`,
    'the cold-start session snapshot',
  );

  const initial = await win.webContents.executeJavaScript(`(() => ({
    current: Number(document.querySelector('.msg-nav-current')?.textContent),
    total: Number(document.querySelector('.flap-number')?.getAttribute('aria-label')),
    rows: document.querySelectorAll('.virtual-timeline-row').length,
    roots: document.querySelectorAll('.msg[data-uuid], .wf-card[data-uuid], .skill-card[data-uuid]').length,
    scrollTop: document.querySelector('.detail-wrap')?.scrollTop,
    scrollHeight: document.querySelector('.detail-wrap')?.scrollHeight,
  }))()`, true);
  assert(initial.scrollTop < 2 && initial.current < 100, `cold start stays at the beginning (scrollTop ${initial.scrollTop}, item ${initial.current})`);
  assert(initial.total === messageCount, `timeline exposes all ${messageCount} items (got ${initial.total})`);
  assert(initial.rows < 60 && initial.roots === initial.rows, `only ${initial.rows} virtual rows are mounted`);

  const disclosure = await win.webContents.executeJavaScript(`(async () => {
    const toggle = document.querySelector('.toolcall-toggle');
    const row = toggle?.closest('.virtual-timeline-row');
    const before = row?.getBoundingClientRect().height || 0;
    toggle?.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = row?.getBoundingClientRect().height || 0;
    const wrap = document.querySelector('.detail-wrap');
    wrap.scrollTop = wrap.scrollHeight * 0.55;
    await new Promise(resolve => setTimeout(resolve, 250));
    const unmounted = !document.querySelector('[data-view-key="tool:call-1"]');
    document.querySelector('button[title="First"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 350));
    return {
      before,
      after,
      unmounted,
      restored: Boolean(document.querySelector('[data-view-key="tool:call-1"].open')),
    };
  })()`, true);
  assert(disclosure.after > disclosure.before, `expanded tool row remeasures from ${disclosure.before}px to ${disclosure.after}px`);
  assert(disclosure.unmounted, 'the expanded tool row unmounts outside overscan');
  assert(disclosure.restored, 'disclosure state survives unmount and remount');

  await win.webContents.executeJavaScript(`window.location.hash = '#/sessions'`, true);
  await waitFor(win.webContents, `!document.querySelector('.virtual-timeline')`, 'session detail deactivation');
  await win.webContents.executeJavaScript(`(async () => {
    const search = document.querySelector('#search');
    search.value = 'SENTINEL';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 300));
  })()`, true);
  await win.webContents.executeJavaScript(
    `window.location.hash = '#/sessions/${sessionId}?focus=${focusMessageUuid}'`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('[data-uuid="${focusMessageUuid}"].is-focused')`,
    'offscreen UUID focus',
  );
  const focusState = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('[data-uuid="${focusMessageUuid}"].is-focused');
    const wrap = document.querySelector('.detail-wrap');
    const targetRect = target.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    return {
      current: Number(document.querySelector('.msg-nav-current')?.textContent),
      visible: targetRect.bottom > wrapRect.top && targetRect.top < wrapRect.bottom,
    };
  })()`, true);
  assert(focusState.visible, `UUID navigation mounts and reveals ${focusMessageUuid} (viewport ends at item ${focusState.current})`);
  const codexDisplayState = await win.webContents.executeJavaScript(`(async () => {
    const tool = document.querySelector('[data-view-key="tool:call-codex-exec"]');
    tool?.querySelector('.toolcall-toggle')?.click();
    tool?.querySelector('.raw-toggle')?.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      open: tool?.classList.contains('open'),
      raw: tool?.querySelector('.raw-toggle')?.classList.contains('active'),
    };
  })()`, true);
  assert(codexDisplayState.open && codexDisplayState.raw, 'Codex exec disclosure and Raw state update without rebuilding its presentation');
  codexExecOutput = JSON.stringify([{
    type: 'input_text',
    text: 'Script completed\nWall time 0.1 seconds\nOutput:\n{"ok":true,"revision":2}',
  }]);
  replaceToolResult(win, 'call-codex-exec', codexExecOutput);
  await waitFor(
    win.webContents,
    `document.querySelector('[data-view-key="tool:call-codex-exec"] .toolcall-raw')?.textContent.includes('revision')`,
    'updated Codex exec result',
  );
  const updatedCodexDisplayState = await win.webContents.executeJavaScript(`(() => {
    const tool = document.querySelector('[data-view-key="tool:call-codex-exec"]');
    return {
      open: tool?.classList.contains('open'),
      raw: tool?.querySelector('.raw-toggle')?.classList.contains('active'),
    };
  })()`, true);
  assert(updatedCodexDisplayState.open && updatedCodexDisplayState.raw, 'Codex exec disclosure and Raw state survive a result update');

  await win.webContents.executeJavaScript(
    `document.querySelector('[data-uuid="${focusMessageUuid}"] .truncated-btn')?.click()`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('[data-uuid="${focusMessageUuid}"]')?.textContent.includes('FULL TEXT SENTINEL')`,
    'expanded full message text',
  );
  const fullTextSearchState = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('[data-uuid="${focusMessageUuid}"]');
    return {
      highlighted: [...target.querySelectorAll('mark')].some(mark => mark.textContent === 'SENTINEL'),
      truncatedButtonRemoved: !target.querySelector('.truncated-btn'),
    };
  })()`, true);
  assert(
    fullTextSearchState.highlighted && fullTextSearchState.truncatedButtonRemoved,
    'full-text expansion re-renders the row and preserves search highlighting',
  );
  await delay(250);

  await win.webContents.executeJavaScript(`(() => {
    const original = window.marked.parse;
    const originalJsonParse = JSON.parse;
    const codexExecOutput = ${JSON.stringify(codexExecOutput)};
    const trackedPrefixes = [...document.querySelectorAll('.virtual-timeline-row [data-uuid]')]
      .map(element => element.getAttribute('data-uuid'))
      .filter(uuid => /^message-\d+$/.test(uuid))
      .map(uuid => 'Message ' + uuid.slice('message-'.length) + ' ');
    let calls = 0;
    let codexExecCalls = 0;
    window.marked.parse = function timelineMarkdownProbe(...args) {
      const text = String(args[0] || '');
      if (trackedPrefixes.some(prefix => text.startsWith(prefix))) calls++;
      return original.apply(this, args);
    };
    JSON.parse = function timelineJsonProbe(value, ...args) {
      if (value === codexExecOutput) codexExecCalls++;
      return originalJsonParse.call(this, value, ...args);
    };
    window.__timelineMarkdownProbe = {
      calls: () => calls,
      codexExecCalls: () => codexExecCalls,
      restore: () => {
        window.marked.parse = original;
        JSON.parse = originalJsonParse;
      },
    };
  })()`, true);
  const stationaryAnchorBefore = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    const wrapRect = wrap.getBoundingClientRect();
    const anchorRow = [...document.querySelectorAll('.virtual-timeline-row')]
      .find(row => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > wrapRect.top && rect.top < wrapRect.bottom;
      });
    const anchorElement = anchorRow?.querySelector('[data-uuid]');
    return anchorElement && {
      uuid: anchorElement.getAttribute('data-uuid'),
      offset: anchorRow.getBoundingClientRect().top - wrapRect.top,
    };
  })()`, true);
  const stationaryTraces = [];
  for (let runIndex = 0; runIndex < stationaryAppendRuns; runIndex++) {
    stationaryTraces.push(await traceStationaryAppend(
      win,
      firstStationaryAppendIndex + runIndex,
      messageCount + runIndex + 1,
      runIndex,
    ));
    await delay(250);
  }
  const stationaryAnchorSelector = `[data-uuid="${stationaryAnchorBefore?.uuid}"]`;
  const stationaryAnchorAfter = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    const target = document.querySelector(${JSON.stringify(stationaryAnchorSelector)});
    const row = target?.closest('.virtual-timeline-row');
    return target && {
      uuid: target.getAttribute('data-uuid'),
      offset: row.getBoundingClientRect().top - wrap.getBoundingClientRect().top,
    };
  })()`, true);
  const unchangedRowRenderCalls = await win.webContents.executeJavaScript(`(() => {
    const calls = {
      markdown: window.__timelineMarkdownProbe.calls(),
      codexExec: window.__timelineMarkdownProbe.codexExecCalls(),
    };
    window.__timelineMarkdownProbe.restore();
    delete window.__timelineMarkdownProbe;
    return calls;
  })()`, true);
  assert(unchangedRowRenderCalls.markdown === 0, `three tail appends perform zero Markdown formatting calls for unchanged mounted rows (got ${unchangedRowRenderCalls.markdown})`);
  assert(unchangedRowRenderCalls.codexExec === 0, `three tail appends perform zero Codex exec JSON decodes for an unchanged mounted row (got ${unchangedRowRenderCalls.codexExec})`);
  assert(
    stationaryAnchorBefore?.uuid === stationaryAnchorAfter?.uuid
      && Math.abs(stationaryAnchorBefore.offset - stationaryAnchorAfter.offset) < 2,
    `stationary live commits preserve reader anchor ${stationaryAnchorBefore?.uuid}`,
  );
  for (const [runIndex, trace] of stationaryTraces.entries()) {
    if (trace.maxTaskMs >= 8.33) console.log(`SLOWEST RENDERER TASK ${runIndex + 1}: ${JSON.stringify(trace.slowestChildren)}`);
    assert(trace.maxTaskMs < 8.33, `stationary live commit ${runIndex + 1} stays inside a 120Hz renderer task budget (${trace.maxTaskMs.toFixed(2)}ms across ${trace.tasks} tasks)`);
  }

  setTimeout(() => appendMessage(win, scrollingAppendIndex), 250);
  const scrollProbe = await win.webContents.executeJavaScript(`new Promise(resolve => {
    const wrap = document.querySelector('.detail-wrap');
    const totalBeforeGesture = Number(document.querySelector('.flap-number')?.getAttribute('aria-label'));
    const originalScrollTo = wrap.scrollTo.bind(wrap);
    let programmaticScrolls = 0;
    const blockAutomaticScrollEnd = event => event.stopImmediatePropagation();
    wrap.addEventListener('scrollend', blockAutomaticScrollEnd, true);
    wrap.scrollTo = (...args) => {
      programmaticScrolls++;
      return originalScrollTo(...args);
    };
    const gaps = [];
    const startedAt = performance.now();
    let previous = startedAt;
    wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: 70, bubbles: true }));
    function frame(now) {
      gaps.push(now - previous);
      previous = now;
      if (now - startedAt >= 400) wrap.scrollTop += 70;
      if (now - startedAt < 1200) requestAnimationFrame(frame);
      else {
        const wrapRect = wrap.getBoundingClientRect();
        const anchorRow = [...document.querySelectorAll('.virtual-timeline-row')]
          .find(row => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > wrapRect.top && rect.top < wrapRect.bottom;
        });
        const anchorElement = anchorRow?.querySelector('[data-uuid]');
        const totalBeforeScrollEnd = Number(document.querySelector('.flap-number')?.getAttribute('aria-label'));
        const flapBeforeScrollEnd = Boolean(document.querySelector('.flap-slot.flipping'));
        wrap.scrollTo = originalScrollTo;
        wrap.removeEventListener('scrollend', blockAutomaticScrollEnd, true);
        wrap.dispatchEvent(new Event('scrollend'));
        resolve({
          totalBeforeGesture,
          totalBeforeScrollEnd,
          flapBeforeScrollEnd,
          programmaticScrolls,
          maxFrameGap: Math.max(...gaps),
          frames: gaps.length,
          rows: document.querySelectorAll('.virtual-timeline-row').length,
          distanceFromTail: wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop,
          anchor: anchorElement && {
            uuid: anchorElement.getAttribute('data-uuid'),
            offset: anchorRow.getBoundingClientRect().top - wrapRect.top,
          },
        });
      }
    }
    requestAnimationFrame(frame);
  })`, true);
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${messageCount + stationaryAppendRuns + 1}'`,
    'reader-position live update',
  );
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-slot.flipping')`,
    'post-scrollend flap animation',
  );
  const readerState = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    const anchorElement = document.querySelector(
      ${JSON.stringify(`[data-uuid="${scrollProbe.anchor?.uuid}"]`)},
    );
    const anchorRow = anchorElement?.closest('.virtual-timeline-row');
    return {
      current: Number(document.querySelector('.msg-nav-current')?.textContent),
      anchor: anchorElement && {
        uuid: anchorElement.getAttribute('data-uuid'),
        offset: anchorRow.getBoundingClientRect().top - wrap.getBoundingClientRect().top,
      },
    };
  })()`, true);
  assert(scrollProbe.rows < 60, `live scrolling keeps mounted rows bounded (${scrollProbe.rows})`);
  assert(
    scrollProbe.totalBeforeScrollEnd === scrollProbe.totalBeforeGesture,
    `wheel-to-scrollend freezes the visible timeline (${scrollProbe.totalBeforeGesture} -> ${scrollProbe.totalBeforeScrollEnd})`,
  );
  assert(
    scrollProbe.programmaticScrolls === 0,
    `wheel-to-scrollend performs zero programmatic scrollTo calls (got ${scrollProbe.programmaticScrolls})`,
  );
  assert(!scrollProbe.flapBeforeScrollEnd, 'wheel-to-scrollend does not start the flap animation');
  assert(scrollProbe.anchor, 'reader anchor is captured before the deferred live commit');
  assert(
    scrollProbe.distanceFromTail > 1000
      && readerState.current < messageCount + stationaryAppendRuns + 1
      && readerState.anchor?.uuid === scrollProbe.anchor?.uuid
      && Math.abs(readerState.anchor.offset - scrollProbe.anchor.offset) < 2,
    `live append preserves reader anchor ${scrollProbe.anchor?.uuid} (${scrollProbe.anchor?.offset}px -> ${readerState.anchor?.offset}px)`,
  );
  assert(scrollProbe.maxFrameGap < 250, `live scroll has no catastrophic long frame (${scrollProbe.maxFrameGap.toFixed(1)}ms)`);

  const updatedReaderText = `Updated ${scrollProbe.anchor.uuid} ${'content identity '.repeat(20)}`;
  await win.webContents.executeJavaScript(`(() => {
    const original = window.marked.parse;
    const targetUuid = ${JSON.stringify(scrollProbe.anchor.uuid)};
    const targetText = ${JSON.stringify(updatedReaderText)};
    const unchangedPrefixes = [...document.querySelectorAll('.virtual-timeline-row [data-uuid]')]
      .map(element => element.getAttribute('data-uuid'))
      .filter(uuid => uuid !== targetUuid && /^message-\d+$/.test(uuid))
      .map(uuid => 'Message ' + uuid.slice('message-'.length) + ' ');
    let targetCalls = 0;
    let unchangedCalls = 0;
    window.marked.parse = function timelineContentIdentityProbe(value, ...args) {
      const text = String(value || '');
      if (text === targetText) targetCalls++;
      if (unchangedPrefixes.some(prefix => text.startsWith(prefix))) unchangedCalls++;
      return original.call(this, value, ...args);
    };
    window.__timelineContentIdentityProbe = {
      calls: () => ({ target: targetCalls, unchanged: unchangedCalls }),
      restore: () => { window.marked.parse = original; },
    };
  })()`, true);
  replaceMessageText(win, scrollProbe.anchor.uuid, updatedReaderText);
  await waitFor(
    win.webContents,
    `document.querySelector('[data-uuid=${JSON.stringify(scrollProbe.anchor.uuid)}]')?.textContent.includes(${JSON.stringify(updatedReaderText.slice(0, 40))})`,
    'visible message content update',
  );
  const contentIdentityCalls = await win.webContents.executeJavaScript(`(() => {
    const calls = window.__timelineContentIdentityProbe.calls();
    window.__timelineContentIdentityProbe.restore();
    delete window.__timelineContentIdentityProbe;
    return calls;
  })()`, true);
  assert(contentIdentityCalls.target === 1, `updated mounted row recomputes its Markdown once (got ${contentIdentityCalls.target})`);
  assert(contentIdentityCalls.unchanged === 0, `updated mounted row leaves other mounted Markdown cached (got ${contentIdentityCalls.unchanged})`);
  assert(
    ipcReads.messages === 1
      && ipcReads.toolCalls === 1
      && ipcReads.toolResults === 1
      && ipcReads.subagents === 1
      && ipcReads.workflows === 1
      && ipcReads.summaries === 1
      && ipcReads.patches === 6
      && ipcReads.patchMessageRows.every(count => count === 1),
    `live updates use six single-message patches after one full snapshot (${JSON.stringify(ipcReads)})`,
  );

  await win.webContents.executeJavaScript(`document.querySelector('button[title="Last"]')?.click()`, true);
  await waitFor(
    win.webContents,
    `document.querySelector('.msg-nav-current')?.textContent === '${messageCount + stationaryAppendRuns + 1}'`,
    'last-item navigation',
  );
  await waitFor(
    win.webContents,
    `(() => { const wrap = document.querySelector('.detail-wrap'); return wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop < 2; })()`,
    'last-item scroll settlement',
  );

  await win.webContents.executeJavaScript(`new Promise(resolve => {
    const wrap = document.querySelector('.detail-wrap');
    wrap.scrollTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight - 20);
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`, true);
  await delay(200);
  await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -24, bubbles: true }));
  })()`, true);
  await delay(200);
  appendMessage(win, nearTailEscapeAppendIndex);
  await delay(150);
  const nearTailPending = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    return {
      total: Number(document.querySelector('.flap-number')?.getAttribute('aria-label')),
      distanceFromTail: wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop,
    };
  })()`, true);
  assert(
    nearTailPending.total === messageCount + stationaryAppendRuns + 1,
    'near-tail upward intent keeps the append pending until scrollend',
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('.detail-wrap')?.dispatchEvent(new Event('scrollend'))`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${messageCount + stationaryAppendRuns + 2}'`,
    'near-tail upward append settlement',
  );
  await delay(500);
  const nearTailSettled = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    return {
      current: Number(document.querySelector('.msg-nav-current')?.textContent),
      total: Number(document.querySelector('.flap-number')?.getAttribute('aria-label')),
      distanceFromTail: wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop,
    };
  })()`, true);
  assert(
    nearTailSettled.current < nearTailSettled.total && nearTailSettled.distanceFromTail > 20,
    `near-tail upward intent is not pulled back to the tail (${JSON.stringify(nearTailSettled)})`,
  );

  await win.webContents.executeJavaScript(`document.querySelector('button[title="Last"]')?.click()`, true);
  await waitFor(
    win.webContents,
    `document.querySelector('.msg-nav-current')?.textContent === '${messageCount + stationaryAppendRuns + 2}'`,
    'last-item navigation after upward escape',
  );
  await waitFor(
    win.webContents,
    `(() => { const wrap = document.querySelector('.detail-wrap'); return wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop < 2; })()`,
    'tail re-entry settlement',
  );
  appendMessage(win, tailAppendIndex);
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${messageCount + stationaryAppendRuns + 3}'`,
    'tail-follow total update',
  );
  await delay(1000);
  const tailState = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    return {
      current: Number(document.querySelector('.msg-nav-current')?.textContent),
      total: Number(document.querySelector('.flap-number')?.getAttribute('aria-label')),
      scrollTop: wrap.scrollTop,
      maxScrollTop: wrap.scrollHeight - wrap.clientHeight,
      distanceFromTail: wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop,
    };
  })()`, true);
  assert(
    tailState.current === messageCount + stationaryAppendRuns + 3 && tailState.distanceFromTail < 2,
    `tail follow reaches item ${messageCount + stationaryAppendRuns + 3} (${JSON.stringify(tailState)})`,
  );

  const reduction = (1 - initial.rows / initial.total) * 100;
  console.log(`PERF: ${initial.total} timeline items -> ${initial.rows} mounted rows (${reduction.toFixed(2)}% fewer roots)`);
  console.log(`PERF: ${scrollProbe.frames} frames, max frame gap ${scrollProbe.maxFrameGap.toFixed(1)}ms during live scroll`);
  win.destroy();
}

app.whenReady()
  .then(run)
  .catch(error => {
    failures++;
    console.error(error.stack || error);
  })
  .finally(() => {
    for (const channel of channels) ipcMain.removeHandler(channel);
    app.exit(failures ? 1 : 0);
  });

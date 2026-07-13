// Production renderer integration test for the dynamic SessionDetail timeline.
// Run: npm run test:electron:timeline
import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const sessionId = 'test-session';
const channels = [
  'db:getSessions',
  'db:getSessionMessages',
  'db:getSessionToolCalls',
  'db:getSessionToolResults',
  'db:getSessionSubagents',
  'db:getSessionWorkflows',
  'db:getSessionSummaries',
  'db:getMemories',
  'db:getProjects',
  'db:getStats',
  'settings:get',
];

let failures = 0;
let firstSessionListRead = true;
const messages = Array.from({ length: 2000 }, (_, index) => ({
  uuid: `message-${index}`,
  type: index % 2 === 0 ? 'user' : 'assistant',
  timestamp: new Date(Date.UTC(2026, 6, 14, 0, 0, index)).toISOString(),
  text: index === 1
    ? ''
    : `Message ${index} ${'dynamic-height content '.repeat((index % 7) + 1)}`,
  content_type: index === 1 ? 'tool_use' : 'text',
  is_meta: 0,
}));
const toolCalls = [{
  id: 'call-1',
  message_uuid: 'message-1',
  name: 'Bash',
  input_json: JSON.stringify({ command: 'printf virtualized' }),
}];
const toolResults = [{
  tool_use_id: 'call-1',
  content: `${'virtualized output\n'.repeat(80)}`,
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

function registerHandlers() {
  ipcMain.handle('db:getSessions', async () => {
    if (firstSessionListRead) {
      firstSessionListRead = false;
      await delay(120);
    }
    return [sessionSummary()];
  });
  ipcMain.handle('db:getSessionMessages', () => messages);
  ipcMain.handle('db:getSessionToolCalls', () => toolCalls);
  ipcMain.handle('db:getSessionToolResults', () => toolResults);
  ipcMain.handle('db:getSessionSubagents', () => []);
  ipcMain.handle('db:getSessionWorkflows', () => []);
  ipcMain.handle('db:getSessionSummaries', () => []);
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
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '2000'`,
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
  assert(initial.total === 2000, `timeline exposes all 2000 items (got ${initial.total})`);
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
  await win.webContents.executeJavaScript(
    `window.location.hash = '#/sessions/${sessionId}?focus=message-1500'`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('[data-uuid="message-1500"].is-focused')`,
    'offscreen UUID focus',
  );
  const focusState = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('[data-uuid="message-1500"].is-focused');
    const wrap = document.querySelector('.detail-wrap');
    const targetRect = target.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    return {
      current: Number(document.querySelector('.msg-nav-current')?.textContent),
      visible: targetRect.bottom > wrapRect.top && targetRect.top < wrapRect.bottom,
    };
  })()`, true);
  assert(focusState.visible, `UUID navigation mounts and reveals message-1500 (viewport ends at item ${focusState.current})`);

  setTimeout(() => appendMessage(win, 2000), 250);
  const scrollProbe = await win.webContents.executeJavaScript(`new Promise(resolve => {
    const wrap = document.querySelector('.detail-wrap');
    const gaps = [];
    const startedAt = performance.now();
    let previous = startedAt;
    function frame(now) {
      gaps.push(now - previous);
      previous = now;
      wrap.scrollTop += 70;
      if (now - startedAt < 1200) requestAnimationFrame(frame);
      else {
        const wrapRect = wrap.getBoundingClientRect();
        const anchorRow = [...document.querySelectorAll('.virtual-timeline-row')]
          .find(row => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > wrapRect.top && rect.top < wrapRect.bottom;
          });
        const anchorElement = anchorRow?.querySelector('[data-uuid]');
        resolve({
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
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '2001'`,
    'reader-position live update',
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
  assert(scrollProbe.anchor, 'reader anchor is captured before the deferred live commit');
  assert(
    scrollProbe.distanceFromTail > 1000
      && readerState.current < 2001
      && readerState.anchor?.uuid === scrollProbe.anchor?.uuid
      && Math.abs(readerState.anchor.offset - scrollProbe.anchor.offset) < 2,
    `live append preserves reader anchor ${scrollProbe.anchor?.uuid} (${scrollProbe.anchor?.offset}px -> ${readerState.anchor?.offset}px)`,
  );
  assert(scrollProbe.maxFrameGap < 250, `live scroll has no catastrophic long frame (${scrollProbe.maxFrameGap.toFixed(1)}ms)`);

  await win.webContents.executeJavaScript(`document.querySelector('button[title="Last"]')?.click()`, true);
  await waitFor(
    win.webContents,
    `document.querySelector('.msg-nav-current')?.textContent === '2001'`,
    'last-item navigation',
  );
  await waitFor(
    win.webContents,
    `(() => { const wrap = document.querySelector('.detail-wrap'); return wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop < 2; })()`,
    'last-item scroll settlement',
  );
  appendMessage(win, 2001);
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '2002'`,
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
    tailState.current === 2002 && tailState.distanceFromTail < 2,
    `tail follow reaches item 2002 (${JSON.stringify(tailState)})`,
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

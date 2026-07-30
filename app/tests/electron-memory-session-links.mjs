import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const sessionId = 'codex:019f6392-0dba-7f13-be12-541db3645a69';
const missingSessionId = 'codex:00000000-0000-0000-0000-000000000000';
const memoryId = 'memory-session-links';
const memoryMarkdown = `# Linked memory

[MR review session](obelisk://session/${encodeURIComponent(sessionId)})

[Missing session](obelisk://session/${encodeURIComponent(missingSessionId)})

\`${sessionId}\`

\`\`\`markdown
[Code sample](obelisk://session/${encodeURIComponent(sessionId)})
\`\`\`
`;

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
  'db:readMemoryFile',
  'db:getProjects',
  'db:getStats',
  'settings:get',
];

let failures = 0;

const session = {
  id: sessionId,
  title: 'MR review session',
  project: 'tcode',
  project_path: '/tmp/tcode',
  source: 'codex',
  started_at: '2026-07-15T02:19:04.014Z',
  ended_at: '2026-07-15T03:00:00.000Z',
  message_count: 1,
  git_branch: 'main',
};

function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else {
    failures++;
    console.error(`FAIL: ${message}`);
  }
}

async function waitFor(webContents, expression, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await webContents.executeJavaScript(`Boolean(${expression})`, true)) return;
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function registerHandlers() {
  ipcMain.handle('db:getSessions', (_event, opts = {}) => {
    if (Array.isArray(opts.ids)) return opts.ids.includes(sessionId) ? [session] : [];
    return [session];
  });
  ipcMain.handle('db:getSessionMessages', () => [{
    uuid: `${sessionId}:000001`,
    session_id: sessionId,
    type: 'assistant',
    role: 'assistant',
    timestamp: '2026-07-15T02:20:00.000Z',
    text: 'Linked session detail',
    content_type: 'text',
    is_meta: 0,
  }]);
  ipcMain.handle('db:getSessionToolCalls', () => []);
  ipcMain.handle('db:getSessionToolResults', () => []);
  ipcMain.handle('db:getSessionPatch', () => null);
  ipcMain.handle('db:getSessionSubagents', () => []);
  ipcMain.handle('db:getSessionWorkflows', () => []);
  ipcMain.handle('db:getSessionSummaries', () => []);
  ipcMain.handle('db:getMessageFullText', () => null);
  ipcMain.handle('db:getMemories', () => [{
    id: memoryId,
    session_id: sessionId,
    project: 'tcode',
    message_start: null,
    message_end: null,
    path: '/tmp/linked-memory.md',
    anchors: null,
    summary: 'A Memory with an explicit Obelisk session link.',
    created_at: '2026-07-30T04:55:28.011Z',
    deleted_at: null,
    deleted_reason: null,
  }]);
  ipcMain.handle('db:readMemoryFile', () => memoryMarkdown);
  ipcMain.handle('db:getProjects', () => [{ project: 'tcode', count: 1 }]);
  ipcMain.handle('db:getStats', () => ({}));
  ipcMain.handle('settings:get', () => ({}));
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
    hash: `/memory/${memoryId}`,
  });
  await waitFor(
    win.webContents,
    `document.querySelectorAll('.markdown-session-link').length === 1`,
    'resolved Memory session link',
  );

  const rendered = await win.webContents.executeJavaScript(`(() => {
    const link = document.querySelector('.markdown-session-link');
    const unavailable = document.querySelector('.markdown-session-reference-unavailable');
    const inlineCodes = [...document.querySelectorAll('.markdown-body code')].map(node => node.textContent);
    return {
      linkText: link?.textContent.trim(),
      linkSessionId: link?.dataset.obeliskSessionId,
      linkHref: link?.getAttribute('href'),
      hasIcon: Boolean(link?.querySelector('svg')),
      unavailableText: unavailable?.textContent.trim(),
      unavailableIsLink: unavailable?.matches('a'),
      inlineCodes,
      renderedLinkCount: document.querySelectorAll('.markdown-body a').length,
    };
  })()`, true);

  assert(rendered.linkText === 'MR review session', `canonical link keeps its descriptive label (${JSON.stringify(rendered)})`);
  assert(rendered.linkSessionId === sessionId, 'resolved link carries the canonical session id');
  assert(rendered.linkHref === `obelisk://session/${encodeURIComponent(sessionId)}`, 'rendered link keeps the canonical Obelisk href');
  assert(rendered.hasIcon, 'rendered link reuses the session icon language');
  assert(rendered.unavailableText === 'Missing session' && rendered.unavailableIsLink === false, 'missing target becomes readable non-link text');
  assert(rendered.inlineCodes.includes(sessionId), 'bare inline session id remains ordinary code');
  assert(rendered.inlineCodes.some(text => text.includes('Code sample')), 'fenced Markdown sample remains code');
  assert(rendered.renderedLinkCount === 1, 'fenced and missing references do not become navigable links');

  await win.webContents.executeJavaScript(
    `document.querySelector('.markdown-session-link').click()`,
    true,
  );
  await waitFor(
    win.webContents,
    `window.location.hash.includes('/sessions/') && document.body.textContent.includes('Linked session detail')`,
    'internal Session Detail navigation',
  );
  const route = await win.webContents.executeJavaScript('window.location.hash', true);
  assert(decodeURIComponent(route).includes(sessionId), `click stays inside Obelisk and opens the requested session (${route})`);

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

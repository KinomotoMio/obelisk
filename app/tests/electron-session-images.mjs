import { app, BrowserWindow, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const sessionId = 'session-image-test';
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
let messages = [];

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

function startImageServer() {
  const wideSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1176" height="768" viewBox="0 0 1176 768"><rect width="1176" height="768" fill="#7c3aed"/></svg>';
  const smallSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#22c55e"/></svg>';
  const server = createServer((request, response) => {
    const svg = request.url === '/wide.svg'
      ? wideSvg
      : request.url === '/small.svg'
        ? smallSvg
        : null;
    if (!svg) {
      response.writeHead(404).end();
      return;
    }
    const send = () => {
      response.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'no-store',
      });
      response.end(svg);
    };
    if (request.url === '/wide.svg') setTimeout(send, 300);
    else send();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function sessionSummary() {
  return {
    id: sessionId,
    title: 'Session image rendering',
    project: 'image-fixture',
    project_path: '/tmp/image-fixture',
    source: 'codex',
    started_at: '2026-07-30T00:00:00.000Z',
    ended_at: '2026-07-30T00:05:00.000Z',
    message_count: messages.length,
    git_branch: 'main',
  };
}

function registerHandlers() {
  ipcMain.handle('db:getSessions', () => [sessionSummary()]);
  ipcMain.handle('db:getSessionMessages', () => messages);
  ipcMain.handle('db:getSessionToolCalls', () => []);
  ipcMain.handle('db:getSessionToolResults', () => []);
  ipcMain.handle('db:getSessionSubagents', () => []);
  ipcMain.handle('db:getSessionWorkflows', () => []);
  ipcMain.handle('db:getSessionSummaries', () => []);
  ipcMain.handle('db:getMemories', () => []);
  ipcMain.handle('db:getProjects', () => [{ project: 'image-fixture', count: 1 }]);
  ipcMain.handle('db:getStats', () => ({}));
  ipcMain.handle('settings:get', () => ({}));
}

async function run() {
  const { server, baseUrl } = await startImageServer();
  let win = null;
  try {
    messages = [
      {
        uuid: 'message-0',
        type: 'user',
        timestamp: '2026-07-30T00:00:00.000Z',
        text: 'Image rendering fixtures',
        content_type: 'text',
        is_meta: 0,
      },
      {
        uuid: 'message-1',
        type: 'assistant',
        timestamp: '2026-07-30T00:01:00.000Z',
        text: `Wide image\n\n![Wide timeline fixture](${baseUrl}/wide.svg "Wide fixture")`,
        content_type: 'text',
        is_meta: 0,
      },
      {
        uuid: 'message-2',
        type: 'assistant',
        timestamp: '2026-07-30T00:02:00.000Z',
        text: `Small image\n\n![Small timeline fixture](${baseUrl}/small.svg)`,
        content_type: 'text',
        is_meta: 0,
      },
      {
        uuid: 'message-3',
        type: 'assistant',
        timestamp: '2026-07-30T00:03:00.000Z',
        text: 'Broken image\n\n![Missing timeline fixture](file:///obelisk-fixtures/missing-session-image.png)',
        content_type: 'text',
        is_meta: 0,
      },
      {
        uuid: 'message-4',
        type: 'user',
        timestamp: '2026-07-30T00:04:00.000Z',
        text: 'Following message',
        content_type: 'text',
        is_meta: 0,
      },
    ];
    registerHandlers();
    win = new BrowserWindow({
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
      hash: '/sessions',
    });
    await waitFor(
      win.webContents,
      `document.body.textContent.includes('Session image rendering')`,
      'session list',
    );
    await win.webContents.executeJavaScript(`(() => {
      window.__wideImageLayout = new Promise(resolve => {
        const observer = new MutationObserver(() => {
          const message = document.querySelector('[data-uuid="message-1"]');
          const host = message?.querySelector('obelisk-session-image');
          const image = host?.shadowRoot?.querySelector('img');
          const row = message?.closest('.virtual-timeline-row');
          if (!image || !row) return;
          observer.disconnect();
          const before = row.getBoundingClientRect().height;
          image.addEventListener('load', () => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
              resolve({
                before,
                after: row.getBoundingClientRect().height,
              });
            }));
          }, { once: true });
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      window.location.hash = ${JSON.stringify(`/sessions/${sessionId}`)};
    })()`, true);

    await waitFor(
      win.webContents,
      `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${messages.length}'`,
      'image fixture timeline',
    );
    const resize = await win.webContents.executeJavaScript('window.__wideImageLayout', true);
    await waitFor(
      win.webContents,
      `document.querySelector('[data-uuid="message-2"] obelisk-session-image')?.shadowRoot?.querySelector('.is-loaded')`,
      'small image load',
    );
    await waitFor(
      win.webContents,
      `document.querySelector('[data-uuid="message-3"] obelisk-session-image')?.shadowRoot?.querySelector('.is-error')`,
      'failed image state',
    );
    await delay(100);

    const layout = await win.webContents.executeJavaScript(`(() => {
      const wrap = document.querySelector('.detail-wrap');
      const wideMessage = document.querySelector('[data-uuid="message-1"]');
      const wideRow = wideMessage.closest('.virtual-timeline-row');
      const nextRow = document.querySelector('[data-uuid="message-2"]').closest('.virtual-timeline-row');
      const wideHost = wideMessage.querySelector('obelisk-session-image');
      const wideImage = wideHost.shadowRoot.querySelector('img');
      const smallHost = document.querySelector('[data-uuid="message-2"] obelisk-session-image');
      const smallImage = smallHost.shadowRoot.querySelector('img');
      const brokenHost = document.querySelector('[data-uuid="message-3"] obelisk-session-image');
      const wideHostRect = wideHost.getBoundingClientRect();
      const wideImageRect = wideImage.getBoundingClientRect();
      const smallImageRect = smallImage.getBoundingClientRect();
      const wideRowRect = wideRow.getBoundingClientRect();
      const nextRowRect = nextRow.getBoundingClientRect();
      return {
        wrapClientWidth: wrap.clientWidth,
        wrapScrollWidth: wrap.scrollWidth,
        wideHostWidth: wideHostRect.width,
        wideImageWidth: wideImageRect.width,
        wideImageHeight: wideImageRect.height,
        wideNaturalWidth: wideImage.naturalWidth,
        wideNaturalHeight: wideImage.naturalHeight,
        smallImageWidth: smallImageRect.width,
        smallNaturalWidth: smallImage.naturalWidth,
        rowHeight: wideRowRect.height,
        rowGap: nextRowRect.top - wideRowRect.bottom,
        brokenText: brokenHost.shadowRoot.querySelector('figcaption')?.textContent || '',
      };
    })()`, true);

    assert(
      resize.after > resize.before + 100,
      `image load grows and remeasures its virtual row (${JSON.stringify(resize)})`,
    );
    assert(
      layout.wrapScrollWidth <= layout.wrapClientWidth + 1,
      `wide images do not add session-level horizontal overflow (${JSON.stringify(layout)})`,
    );
    assert(
      layout.wideImageWidth <= layout.wideHostWidth + 1
        && Math.abs(
          layout.wideImageWidth / layout.wideImageHeight
          - layout.wideNaturalWidth / layout.wideNaturalHeight
        ) < 0.01,
      `wide images fit their host and preserve aspect ratio (${JSON.stringify(layout)})`,
    );
    assert(
      layout.smallImageWidth <= layout.smallNaturalWidth + 1,
      `small images keep their intrinsic width (${JSON.stringify(layout)})`,
    );
    assert(
      layout.rowHeight > layout.wideImageHeight && layout.rowGap >= 13,
      `measured image rows do not overlap the following row (${JSON.stringify(layout)})`,
    );
    assert(
      layout.brokenText.includes('Image unavailable')
        && layout.brokenText.includes('Missing timeline fixture'),
      `failed images remain contained with fallback text (${JSON.stringify(layout)})`,
    );
  } finally {
    win?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
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

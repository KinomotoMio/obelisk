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
const FILLER_COUNT = 40;

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

// Renderer-side probes resolve from event handlers that a regression can keep
// from ever firing. Racing every one of them against a deadline keeps a broken
// build reporting a failure instead of hanging the run.
async function withDeadline(promise, message, timeoutMs = 10_000) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${message}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function startImageServer() {
  const wideSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1176" height="768" viewBox="0 0 1176 768"><rect width="1176" height="768" fill="#7c3aed"/></svg>';
  const smallSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#22c55e"/></svg>';
  // Held until the test releases them, so an above-viewport image can be made
  // to finish loading at a moment the test controls.
  const heldSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200"><rect width="900" height="1200" fill="#0ea5e9"/></svg>';
  const heldPaths = ['/held-rest.svg', '/held-scroll.svg'];
  const heldResponses = new Map(heldPaths.map(path => [path, []]));
  const releasedPaths = new Set();
  const sendSvg = (response, svg) => {
    response.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-store',
    });
    response.end(svg);
  };
  const server = createServer((request, response) => {
    if (heldResponses.has(request.url)) {
      if (releasedPaths.has(request.url)) sendSvg(response, heldSvg);
      else heldResponses.get(request.url).push(response);
      return;
    }
    const svg = request.url === '/wide.svg'
      ? wideSvg
      : request.url === '/small.svg'
        ? smallSvg
        : null;
    if (!svg) {
      response.writeHead(404).end();
      return;
    }
    if (request.url === '/wide.svg') setTimeout(() => sendSvg(response, wideSvg), 300);
    else sendSvg(response, smallSvg);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        heldRequestCount: path => heldResponses.get(path)?.length ?? 0,
        releaseHeldImage(path) {
          releasedPaths.add(path);
          const pending = heldResponses.get(path) ?? [];
          heldResponses.set(path, []);
          for (const response of pending) sendSvg(response, heldSvg);
        },
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
  const { server, baseUrl, heldRequestCount, releaseHeldImage } = await startImageServer();
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
      {
        uuid: 'message-5',
        type: 'assistant',
        timestamp: '2026-07-30T00:05:00.000Z',
        text: `Held image (at rest)\n\n![Held rest fixture](${baseUrl}/held-rest.svg)`,
        content_type: 'text',
        is_meta: 0,
      },
      {
        uuid: 'message-6',
        type: 'assistant',
        timestamp: '2026-07-30T00:06:00.000Z',
        text: `Held image (during scroll)\n\n![Held scroll fixture](${baseUrl}/held-scroll.svg)`,
        content_type: 'text',
        is_meta: 0,
      },
      ...Array.from({ length: FILLER_COUNT }, (_, offset) => ({
        uuid: `message-${7 + offset}`,
        type: offset % 2 === 0 ? 'user' : 'assistant',
        timestamp: new Date(Date.UTC(2026, 6, 30, 1, offset)).toISOString(),
        text: `Filler ${offset}. ${'Timeline body copy that gives the row a realistic height. '.repeat(6)}`,
        content_type: 'text',
        is_meta: 0,
      })),
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
      window.__wideImageLayout = new Promise((resolve, reject) => {
        const fail = reason => {
          observer.disconnect();
          reject(new Error(reason));
        };
        const timer = setTimeout(() => fail('wide image never reported a layout'), 8000);
        const settle = value => {
          clearTimeout(timer);
          resolve(value);
        };
        const observer = new MutationObserver(() => {
          const message = document.querySelector('[data-uuid="message-1"]');
          const host = message?.querySelector('obelisk-session-image');
          const image = host?.shadowRoot?.querySelector('img');
          const row = message?.closest('.virtual-timeline-row');
          if (!image || !row) return;
          observer.disconnect();
          const before = row.getBoundingClientRect().height;
          image.addEventListener('error', () => fail('wide image failed to load'), { once: true });
          image.addEventListener('load', () => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
              settle({
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
    const resize = await withDeadline(
      win.webContents.executeJavaScript('window.__wideImageLayout', true),
      'wide image row remeasurement',
    );
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
      // Row spacing is applied by the virtualizer, not by CSS on the row, so
      // calibrate against the spacing the rest of this timeline is using rather
      // than hard-coding the current value.
      const mountedRows = [...document.querySelectorAll('.virtual-timeline-row')]
        .map(row => ({ index: Number(row.dataset.index), rect: row.getBoundingClientRect() }))
        .sort((left, right) => left.index - right.index);
      const gaps = mountedRows
        .slice(1)
        .map((row, offset) => row.rect.top - mountedRows[offset].rect.bottom)
        .sort((left, right) => left - right);
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
        typicalRowGap: gaps[Math.floor(gaps.length / 2)] ?? null,
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
      layout.rowHeight > layout.wideImageHeight
        && layout.typicalRowGap !== null
        && Math.abs(layout.rowGap - layout.typicalRowGap) <= 1,
      `measured image rows do not overlap the following row (${JSON.stringify(layout)})`,
    );
    assert(
      layout.brokenText.includes('Image unavailable')
        && layout.brokenText.includes('Missing timeline fixture'),
      `failed images remain contained with fallback text (${JSON.stringify(layout)})`,
    );

    // --- Reader position must survive an above-viewport image finishing. ---
    // Both fixtures sit above the viewport for the rest of the run, so this also
    // confirms a mounted row fetches its image without being on screen.
    assert(
      heldRequestCount('/held-rest.svg') > 0 && heldRequestCount('/held-scroll.svg') > 0,
      'mounted rows request their images while off screen'
        + ` (${heldRequestCount('/held-rest.svg')}, ${heldRequestCount('/held-scroll.svg')})`,
    );

    const parkAbove = distance => win.webContents.executeJavaScript(`(() => {
      const wrap = document.querySelector('.detail-wrap');
      const wrapRect = wrap.getBoundingClientRect();
      const row = document.querySelector('[data-uuid="message-6"]').closest('.virtual-timeline-row');
      const rowRect = row.getBoundingClientRect();
      wrap.scrollTop += (rowRect.bottom - wrapRect.top) + ${distance};
      return wrap.scrollTop;
    })()`, true);

    const captureGeometry = () => win.webContents.executeJavaScript(`(() => {
      const wrap = document.querySelector('.detail-wrap');
      const wrapRect = wrap.getBoundingClientRect();
      const rows = [...document.querySelectorAll('.virtual-timeline-row')]
        .map(row => ({
          uuid: row.querySelector('[data-uuid]')?.getAttribute('data-uuid'),
          rect: row.getBoundingClientRect(),
        }))
        .filter(row => row.uuid && row.rect.bottom > wrapRect.top && row.rect.top < wrapRect.bottom)
        .sort((left, right) => left.rect.top - right.rect.top);
      return {
        scrollTop: wrap.scrollTop,
        firstVisible: rows[0]?.uuid || null,
        tops: Object.fromEntries(rows.map(row => [row.uuid, row.rect.top - wrapRect.top])),
      };
    })()`, true);

    await parkAbove(420);
    // Longer than isScrollingResetDelay so the virtualizer is genuinely at rest.
    await delay(700);
    await waitFor(
      win.webContents,
      `document.querySelector('[data-uuid="message-5"] obelisk-session-image')?.shadowRoot?.querySelector('.is-loading')`,
      'held rest image still pending above the viewport',
    );
    const restBefore = await captureGeometry();
    releaseHeldImage('/held-rest.svg');
    await waitFor(
      win.webContents,
      `document.querySelector('[data-uuid="message-5"] obelisk-session-image')?.shadowRoot?.querySelector('.is-loaded')`,
      'held rest image load',
    );
    await delay(250);
    const restAfter = await captureGeometry();
    const restAnchor = restBefore.firstVisible;
    const restDrift = restAnchor !== null && restAfter.tops[restAnchor] !== undefined
      ? restAfter.tops[restAnchor] - restBefore.tops[restAnchor]
      : Number.NaN;
    assert(
      Math.abs(restDrift) <= 1,
      'an image loading above the viewport does not move the reader position'
        + ` (${JSON.stringify({ anchor: restAnchor, drift: restDrift, scrollTop: [restBefore.scrollTop, restAfter.scrollTop] })})`,
    );

    // Same guarantee mid-gesture: scrolling back through history is when rows
    // above the viewport are most likely to still be settling their media.
    await parkAbove(2_000);
    await delay(700);
    await waitFor(
      win.webContents,
      `document.querySelector('[data-uuid="message-6"] obelisk-session-image')?.shadowRoot?.querySelector('.is-loading')`,
      'held scroll image still pending above the viewport',
    );
    const scrollProbe = win.webContents.executeJavaScript(`new Promise(resolve => {
      const wrap = document.querySelector('.detail-wrap');
      const blockAutomaticScrollEnd = event => event.stopImmediatePropagation();
      wrap.addEventListener('scrollend', blockAutomaticScrollEnd, true);
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -70, bubbles: true }));
      let previous = null;
      let maxResidual = 0;
      let example = null;
      const startedAt = performance.now();
      function frame(now) {
        wrap.scrollTop -= 12;
        const wrapRect = wrap.getBoundingClientRect();
        const scrollTop = wrap.scrollTop;
        const rows = new Map([...document.querySelectorAll('.virtual-timeline-row')]
          .map(row => [
            row.querySelector('[data-uuid]')?.getAttribute('data-uuid'),
            row.getBoundingClientRect().top - wrapRect.top,
          ])
          .filter(([uuid, top]) => uuid && top > -200 && top < wrapRect.height));
        if (previous) {
          for (const [uuid, top] of rows) {
            if (!previous.rows.has(uuid)) continue;
            const residual = (top - previous.rows.get(uuid)) + (scrollTop - previous.scrollTop);
            if (Math.abs(residual) > Math.abs(maxResidual)) {
              maxResidual = residual;
              example = { uuid, residual, scrollTop };
            }
          }
        }
        previous = { rows, scrollTop };
        if (now - startedAt < 1500) {
          requestAnimationFrame(frame);
          return;
        }
        wrap.removeEventListener('scrollend', blockAutomaticScrollEnd, true);
        wrap.dispatchEvent(new Event('scrollend'));
        resolve({ maxResidual, example });
      }
      requestAnimationFrame(frame);
    })`, true);
    await delay(500);
    releaseHeldImage('/held-scroll.svg');
    const scrolling = await withDeadline(scrollProbe, 'backward scroll residual probe');
    assert(
      Math.abs(scrolling.maxResidual) <= 2,
      'an image loading above the viewport does not move visible rows mid-scroll'
        + ` (${JSON.stringify(scrolling)})`,
    );
  } finally {
    win?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

app.whenReady()
  .then(() => withDeadline(run(), 'the session image suite to finish', 180_000))
  .catch(error => {
    failures++;
    console.error(error.stack || error);
  })
  .finally(() => {
    for (const channel of channels) ipcMain.removeHandler(channel);
    app.exit(failures ? 1 : 0);
  });

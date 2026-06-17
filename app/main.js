const { app, BrowserWindow, ipcMain, clipboard, dialog, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');
const { writeHeartbeat } = require('./indexer');
const { createIndexerService } = require('./indexer-service');
const { createWorkerBuildIndex } = require('./indexer-worker-client');
const { buildRecapExportQuery } = require('./recap-capture-query');

function detectClaudeDir() {
  // macOS / Linux: ~/.claude
  if (process.platform !== 'win32') {
    return path.join(os.homedir(), '.claude');
  }
  // Windows: Claude Code runs in WSL, data lives at \\wsl.localhost\<distro>\home\<user>\.claude
  const distros = ['Ubuntu', 'Ubuntu-24.04', 'Ubuntu-22.04', 'Debian', 'openSUSE-Leap', 'kali-linux'];
  for (const distro of distros) {
    const homePath = path.join('\\\\wsl.localhost', distro, 'home');
    if (!fs.existsSync(homePath)) continue;
    try {
      const users = fs.readdirSync(homePath);
      for (const user of users) {
        const claudeDir = path.join(homePath, user, '.claude');
        if (fs.existsSync(claudeDir)) return claudeDir;
      }
    } catch {}
  }
  // Fallback: native Windows path (for future native Claude Code on Windows)
  return path.join(os.homedir(), '.claude');
}

const DEFAULT_CLAUDE_DIR = detectClaudeDir();
const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');

let db;
let indexerService;
let indexerWorker;

function getConfiguredClaudeDir() {
  const persisted = loadPersistedSettings();
  return persisted.claudeDir || DEFAULT_CLAUDE_DIR;
}

function getConfiguredCodexDir() {
  const persisted = loadPersistedSettings();
  return persisted.codexDir || DEFAULT_CODEX_DIR;
}

function getPathsForClaudeDir(claudeDir = getConfiguredClaudeDir(), codexDir = getConfiguredCodexDir()) {
  return {
    claudeDir,
    codexDir,
    dbPath: path.join(OBELISK_DIR, 'obelisk.sqlite'),
    projectsDir: path.join(claudeDir, 'projects'),
  };
}

function migrateLegacyDbIfNeeded(paths = getPathsForClaudeDir()) {
  if (fs.existsSync(paths.dbPath)) return;
  const legacyDbPath = path.join(paths.claudeDir, 'obelisk.sqlite');
  if (!fs.existsSync(legacyDbPath)) return;
  try {
    fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true });
    fs.copyFileSync(legacyDbPath, paths.dbPath);
  } catch (error) {
    console.warn?.(`Obelisk legacy DB migration skipped: ${error.message}`);
  }
}

function rebuildTempDbPath(dbPath) {
  return path.join(
    path.dirname(dbPath),
    `${path.basename(dbPath)}.rebuild-${process.pid}-${Date.now()}.tmp`,
  );
}

function dbFileSet(dbPath) {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

function cleanupDbFiles(dbPath) {
  for (const filePath of dbFileSet(dbPath)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
  }
}

function replaceDbWithTemp(tempDbPath, dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.rmSync(sidecar, { force: true });
    } catch {}
  }
  fs.renameSync(tempDbPath, dbPath);
  for (const suffix of ['-wal', '-shm']) {
    const tempSidecar = `${tempDbPath}${suffix}`;
    if (!fs.existsSync(tempSidecar)) continue;
    fs.renameSync(tempSidecar, `${dbPath}${suffix}`);
  }
}

function resolveSchemaPath() {
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', 'scripts', 'schema.sql'),
    process.resourcesPath ? path.join(process.resourcesPath, 'scripts', 'schema.sql') : null,
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p));
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function migrateExistingColumns(db) {
  if (tableExists(db, 'sessions')) ensureColumn(db, 'sessions', 'source', "TEXT DEFAULT 'claude'");
  if (tableExists(db, 'messages')) {
    ensureColumn(db, 'messages', 'content_type', 'TEXT');
    ensureColumn(db, 'messages', 'is_meta', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'messages', 'source', "TEXT DEFAULT 'claude'");
  }
  if (tableExists(db, 'memories')) {
    ensureColumn(db, 'memories', 'anchors', 'TEXT');
    ensureColumn(db, 'memories', 'deleted_at', 'TEXT');
    ensureColumn(db, 'memories', 'deleted_reason', 'TEXT');
  }
}

function migrateDb(db) {
  if (typeof db.exec !== 'function' || typeof db.prepare !== 'function') return;
  migrateExistingColumns(db);
  const schemaPath = resolveSchemaPath();
  if (schemaPath) db.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrateExistingColumns(db);
}

function closeDb() {
  if (db) db.close();
  db = null;
}

function openDb(dbPath = getPathsForClaudeDir().dbPath) {
  closeDb();
  if (!fs.existsSync(dbPath)) return null;
  db = new Database(dbPath, { readonly: false });
  db.pragma('journal_mode = WAL');
  migrateDb(db);
  return db;
}

function notifyIndexUpdated(result = {}) {
  const affectedSessionIds = Array.isArray(result.affectedSessionIds)
    ? [...new Set(result.affectedSessionIds.filter(Boolean))]
    : [];
  const payload = { affectedSessionIds };
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('obelisk:index-updated', payload);
    for (const sessionId of affectedSessionIds) {
      win.webContents.send('obelisk:session-updated', { sessionId });
    }
  }
}

function sourceWhereClause(opts = {}, column = 'source') {
  if (opts.includeCodex || opts.source === 'all') return { sql: '', params: [] };
  if (opts.source) return { sql: `COALESCE(${column}, 'claude') = ?`, params: [opts.source] };
  return { sql: `COALESCE(${column}, 'claude') = 'claude'`, params: [] };
}

function appendWhere(sql, params, clause) {
  if (!clause) return sql;
  return `${sql}${sql.includes(' WHERE ') ? ' AND ' : ' WHERE '}${clause}`;
}

function startIndexerService({ buildOnStart = false } = {}) {
  const paths = getPathsForClaudeDir();
  migrateLegacyDbIfNeeded(paths);
  const codexSessionsDir = path.join(paths.codexDir, 'sessions');
  indexerService = createIndexerService({
    projectsDir: paths.projectsDir,
    watchDirs: [paths.projectsDir, codexSessionsDir],
    buildIndex: async ({ reason, changedPaths }) => {
      const result = await indexerWorker.buildIndex({
        reason,
        changedPaths,
        claudeDir: paths.claudeDir,
        codexDir: paths.codexDir,
        projectsDir: paths.projectsDir,
        dbPath: paths.dbPath,
      });
      openDb(paths.dbPath);
      notifyIndexUpdated(result);
      return result;
    },
    writeHeartbeat: () => writeHeartbeat({ dbPath: paths.dbPath }),
  });
  indexerService.start({ buildOnStart });
  return indexerService;
}

function startBackgroundResources({ runStartupBuild = false } = {}) {
  if (!indexerWorker) indexerWorker = createWorkerBuildIndex();
  const paths = getPathsForClaudeDir();
  migrateLegacyDbIfNeeded(paths);
  openDb(paths.dbPath);
  if (!indexerService) {
    const service = startIndexerService({ buildOnStart: false });
    if (runStartupBuild) service.runBuildNow('startup');
  }
  if (!obeliskWatcher) startObeliskWatcher();
}

async function stopIndexerServiceAndWait({ waitForIdle = true } = {}) {
  const service = indexerService;
  if (!service) return;
  service.stop();
  if (waitForIdle && typeof service.idle === 'function') await service.idle();
  if (indexerService === service) indexerService = null;
}

async function stopBackgroundResources({ stopWorker = false } = {}) {
  await stopIndexerServiceAndWait();
  if (stopWorker && indexerWorker) {
    indexerWorker.stop();
    indexerWorker = null;
  }
  if (obeliskWatcher) {
    const watcher = obeliskWatcher;
    obeliskWatcher = null;
    if (typeof watcher.close === 'function') await Promise.resolve(watcher.close());
  }
  closeDb();
}

function createWindow() {
  const isDev = process.argv.includes('--dev');
  const shouldOpenDevTools = process.argv.includes('--devtools');

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 10 },
    backgroundColor: '#0a0b14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: isDev || shouldOpenDevTools,
    },
  });

  // Prevent Electron's built-in zoom so Cmd+=/- reaches the renderer
  win.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && ['+', '=', '-', '0'].includes(input.key)) {
      win.webContents.setZoomLevel(0);
    }
  });

  if (isDev) {
    win.loadURL(process.env.OBELISK_DEV_SERVER_URL || 'http://localhost:5173');
    if (shouldOpenDevTools) {
      win.webContents.openDevTools();
    }
  } else {
    win.loadFile(path.join(__dirname, 'dist-renderer', 'index.html'));
  }
}

const OBELISK_DIR = path.join(os.homedir(), '.obelisk');
const RECAP_DIR = path.join(OBELISK_DIR, 'recap');
let obeliskWatcher = null;

function startObeliskWatcher() {
  if (obeliskWatcher) return obeliskWatcher;
  const chokidar = require('chokidar');
  if (!fs.existsSync(OBELISK_DIR)) {
    fs.mkdirSync(OBELISK_DIR, { recursive: true });
  }
  obeliskWatcher = chokidar.watch(OBELISK_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignored: (p, stats) => {
      if (stats?.isDirectory()) return false;
      if (!stats) return false;
      return !p.endsWith('.md') && !p.endsWith('.json');
    },
  });
  obeliskWatcher.on('add', onObeliskChange);
  obeliskWatcher.on('change', onObeliskChange);
  obeliskWatcher.on('unlink', onObeliskChange);
  return obeliskWatcher;
}

function onObeliskChange(filePath) {
  if (filePath.startsWith(RECAP_DIR)) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('obelisk:recap-updated', filePath);
    }
  }
}

app.whenReady().then(() => {
  startBackgroundResources({ runStartupBuild: true });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      startBackgroundResources({ runStartupBuild: true });
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  void stopBackgroundResources({ stopWorker: true });
});

app.on('window-all-closed', () => {
  void stopBackgroundResources({ stopWorker: true });
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

ipcMain.handle('db:getSessions', (_, opts = {}) => {
  if (!db) return [];
  const { project, limit = 200 } = opts;
  let sql = `SELECT id, title, project, project_path, started_at, ended_at, git_branch, version, message_count, jsonl_path, source FROM sessions`;
  const params = [];
  const sourceFilter = sourceWhereClause(opts);
  if (sourceFilter.sql) {
    sql = appendWhere(sql, params, sourceFilter.sql);
    params.push(...sourceFilter.params);
  }
  if (project) { sql = appendWhere(sql, params, `project LIKE ?`); params.push(project); }
  sql += ` ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
});

ipcMain.handle('db:getSessionMessages', (_, sessionId) => {
  if (!db) return [];
  return db.prepare(`
    SELECT m.uuid, m.session_id, m.type, m.parent_uuid, m.timestamp, m.role, m.text, m.model,
           m.is_sidechain, m.agent_id, m.input_tokens, m.output_tokens, m.cwd, m.skill, m.turn_duration_ms,
           m.content_type, m.is_meta, m.source
    FROM messages m WHERE m.session_id = ? AND m.agent_id IS NULL ORDER BY m.timestamp, m.uuid
  `).all(sessionId);
});

ipcMain.handle('db:getSessionToolCalls', (_, sessionId) => {
  if (!db) return [];
  return db.prepare(`SELECT * FROM tool_calls WHERE session_id = ?`).all(sessionId);
});

ipcMain.handle('db:getSessionToolResults', (_, sessionId) => {
  if (!db) return [];
  return db.prepare(`SELECT * FROM tool_results WHERE session_id = ?`).all(sessionId);
});

ipcMain.handle('db:getSessionSubagents', (_, sessionId) => {
  if (!db) return [];
  return db.prepare(`SELECT * FROM subagents WHERE session_id = ?`).all(sessionId);
});

ipcMain.handle('db:getSessionWorkflows', (_, sessionId) => {
  if (!db) return [];
  const workflows = db.prepare(`SELECT * FROM workflows WHERE session_id = ?`).all(sessionId);
  for (const wf of workflows) {
    wf.agents = db.prepare(`SELECT * FROM workflow_agents WHERE run_id = ?`).all(wf.run_id);
  }
  return workflows;
});

ipcMain.handle('db:getSubagentMessages', (_, agentId) => {
  if (!db) return [];
  return db.prepare(`
    SELECT m.uuid, m.session_id, m.type, m.parent_uuid, m.timestamp, m.role, m.text, m.model,
           m.is_sidechain, m.agent_id, m.input_tokens, m.output_tokens, m.cwd, m.skill, m.turn_duration_ms,
           m.content_type, m.is_meta, m.source
    FROM messages m WHERE m.agent_id = ? ORDER BY m.timestamp, m.uuid
  `).all(agentId);
});

ipcMain.handle('db:getSubagentToolCalls', (_, agentId) => {
  if (!db) return [];
  return db.prepare(`
    SELECT tc.* FROM tool_calls tc
    JOIN messages m ON m.uuid = tc.message_uuid
    WHERE m.agent_id = ?
  `).all(agentId);
});

ipcMain.handle('db:getSubagentToolResults', (_, agentId) => {
  if (!db) return [];
  return db.prepare(`
    SELECT tr.* FROM tool_results tr
    JOIN messages m ON m.uuid = tr.message_uuid
    WHERE m.agent_id = ?
  `).all(agentId);
});

ipcMain.handle('db:getSessionSummaries', (_, sessionId) => {
  if (!db) return [];
  return db.prepare(`SELECT * FROM summaries WHERE session_id = ?`).all(sessionId);
});

ipcMain.handle('db:getMemories', () => {
  if (!db) return [];
  return db.prepare(`
    SELECT id, session_id, project, message_start, message_end, path, anchors, summary, created_at, deleted_at, deleted_reason
    FROM memories ORDER BY created_at DESC
  `).all();
});

ipcMain.handle('db:getMessageFullText', (_, uuid) => {
  if (!db) return null;
  const msg = db.prepare('SELECT session_id, agent_id, source FROM messages WHERE uuid=?').get(uuid);
  if (!msg) return null;

  if (msg.source === 'codex' || String(uuid).startsWith('codex:')) {
    const match = /^codex:([^:]+):(\d+)$/.exec(String(uuid));
    if (!match) return null;
    const rawThreadId = match[1];
    const targetLine = Number(match[2]);
    let jsonlPath = null;
    if (!msg.agent_id) {
      jsonlPath = db.prepare('SELECT jsonl_path FROM sessions WHERE id=?').get(msg.session_id)?.jsonl_path || null;
    }
    if (!jsonlPath) {
      jsonlPath = db.prepare(`
        SELECT jsonl_path FROM index_state
        WHERE jsonl_path LIKE ? AND jsonl_path LIKE '%.jsonl'
        ORDER BY length(jsonl_path) ASC
        LIMIT 1
      `).get(`%${rawThreadId}.jsonl`)?.jsonl_path || null;
    }
    if (!jsonlPath || !fs.existsSync(jsonlPath)) return null;
    const lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
    const line = lines[targetLine - 1];
    if (!line) return null;
    try {
      const obj = JSON.parse(line);
      const payload = obj.payload || {};
      if (obj.type === 'event_msg') {
        if (typeof payload.message === 'string') return payload.message;
        if (typeof payload.text === 'string') return payload.text;
      }
      if (obj.type === 'response_item' && payload.type === 'message' && Array.isArray(payload.content)) {
        const parts = payload.content.map(b => b.text).filter(Boolean);
        return parts.join('\n') || null;
      }
    } catch {}
    return null;
  }

  // Resolve JSONL path
  let jsonlPath = null;
  if (msg.agent_id) {
    const wa = db.prepare('SELECT agent_id, run_id, session_id FROM workflow_agents WHERE agent_id=?').get(msg.agent_id);
    if (wa) {
      const ses = db.prepare('SELECT jsonl_path FROM sessions WHERE id=?').get(wa.session_id);
      if (ses) jsonlPath = path.join(path.dirname(ses.jsonl_path), wa.session_id, 'subagents', 'workflows', wa.run_id, wa.agent_id + '.jsonl');
    }
    if (!jsonlPath) {
      const sa = db.prepare('SELECT agent_id, session_id FROM subagents WHERE agent_id=?').get(msg.agent_id);
      if (sa) {
        const ses = db.prepare('SELECT jsonl_path FROM sessions WHERE id=?').get(sa.session_id);
        if (ses) jsonlPath = path.join(path.dirname(ses.jsonl_path), sa.session_id, 'subagents', sa.agent_id + '.jsonl');
      }
    }
  }
  if (!jsonlPath) {
    const ses = db.prepare('SELECT jsonl_path FROM sessions WHERE id=?').get(msg.session_id);
    if (ses) jsonlPath = ses.jsonl_path;
  }
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return null;

  // Scan JSONL for the message UUID and extract full text
  const readline = require('readline');
  const data = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = data.split('\n');
  for (const line of lines) {
    if (!line.includes(uuid)) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.uuid !== uuid) continue;
      const content = obj.message?.content;
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return null;
      const parts = [];
      for (const b of content) {
        if (b.type === 'text' && b.text) parts.push(b.text);
        else if (b.type === 'thinking' && b.thinking) parts.push(b.thinking);
      }
      return parts.join('\n') || null;
    } catch { continue; }
  }
  return null;
});

ipcMain.handle('db:readMemoryFile', (_, filePath) => {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
    return null;
  } catch { return null; }
});

ipcMain.handle('db:archiveMemory', (_, id, reason) => {
  if (!db) return false;
  db.prepare(`UPDATE memories SET deleted_at = ?, deleted_reason = ? WHERE id = ?`)
    .run(new Date().toISOString(), reason || 'Archived via panel', id);
  return true;
});

ipcMain.handle('db:restoreMemory', (_, id) => {
  if (!db) return false;
  db.prepare(`UPDATE memories SET deleted_at = NULL, deleted_reason = NULL WHERE id = ?`).run(id);
  return true;
});

ipcMain.handle('db:getProjects', (_, opts = {}) => {
  if (!db) return [];
  const sourceFilter = sourceWhereClause(opts);
  const where = sourceFilter.sql ? `WHERE ${sourceFilter.sql}` : '';
  return db.prepare(`
    SELECT project, project_path, COUNT(*) as session_count,
           MAX(COALESCE(ended_at, started_at)) as last_active
    FROM sessions ${where ? `${where} AND` : 'WHERE'} project IS NOT NULL
    GROUP BY project ORDER BY last_active DESC
  `).all(...sourceFilter.params);
});

ipcMain.handle('db:getStats', (_, opts = {}) => {
  if (!db) return { sessions: 0, memories: 0, memoriesArchived: 0 };
  const sourceFilter = sourceWhereClause(opts);
  const where = sourceFilter.sql ? `WHERE ${sourceFilter.sql}` : '';
  const sessions = db.prepare(`SELECT COUNT(*) as c FROM sessions ${where}`).get(...sourceFilter.params)?.c || 0;
  const memories = db.prepare('SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL').get()?.c || 0;
  const memoriesArchived = db.prepare('SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NOT NULL').get()?.c || 0;
  return { sessions, memories, memoriesArchived };
});

ipcMain.handle('db:getUsageStats', (_, opts = {}) => {
  if (!db) return { daily: [], totalTokens: 0, peakDay: null, longestTurn: null };
  const sourceFilter = sourceWhereClause(opts, 'source');
  const sourceSql = sourceFilter.sql ? `AND ${sourceFilter.sql}` : '';

  const daily = db.prepare(`
    SELECT DATE(timestamp) as day,
           SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) as tokens
    FROM messages
    WHERE timestamp IS NOT NULL AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
      ${sourceSql}
    GROUP BY DATE(timestamp)
    ORDER BY day
  `).all(...sourceFilter.params);

  const totalTokens = db.prepare(`
    SELECT SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) as total
    FROM messages
    ${sourceFilter.sql ? `WHERE ${sourceFilter.sql}` : ''}
  `).get(...sourceFilter.params)?.total || 0;

  const peakDay = db.prepare(`
    SELECT DATE(timestamp) as day,
           SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) as tokens
    FROM messages
    WHERE timestamp IS NOT NULL AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
      ${sourceSql}
    GROUP BY DATE(timestamp)
    ORDER BY tokens DESC
    LIMIT 1
  `).get(...sourceFilter.params) || null;

  const longestTurn = db.prepare(`
    SELECT turn_duration_ms, uuid, session_id, timestamp
    FROM messages
    WHERE turn_duration_ms IS NOT NULL
      ${sourceSql}
    ORDER BY turn_duration_ms DESC
    LIMIT 1
  `).get(...sourceFilter.params) || null;

  return { daily, totalTokens, peakDay, longestTurn };
});

// --- Capture ---

const EXPORT_WIDTH = 540;
const EXPORT_HEIGHT = 675;

async function createExportCapture(parentWin, query) {
  const exportWin = new BrowserWindow({
    width: EXPORT_WIDTH,
    height: EXPORT_HEIGHT,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      deviceScaleFactor: 2,
    },
  });

  const isDev = process.argv.includes('--dev');
  const url = isDev
    ? `http://localhost:5173/#/recap-export?${query}`
    : `file://${path.join(__dirname, 'dist-renderer', 'index.html')}#/recap-export?${query}`;

  await exportWin.loadURL(url);
  await waitForExportReady(exportWin.webContents);

  const image = await exportWin.webContents.capturePage({
    x: 0, y: 0, width: EXPORT_WIDTH, height: EXPORT_HEIGHT,
  });
  exportWin.close();
  return image;
}

async function waitForExportReady(webContents, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const ready = await webContents.executeJavaScript('window.__OBELISK_RECAP_EXPORT_READY__ === true', true);
      if (ready) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

ipcMain.handle('capture:export', async (event, { cardIdx, archetype, filename } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const query = buildRecapExportQuery({ cardIdx, archetype, filename });
  const image = await createExportCapture(win, query);
  const { filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `obelisk-recap-${cardIdx + 1}.png`,
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (!filePath) return null;
  fs.writeFileSync(filePath, image.toPNG());
  return filePath;
});

ipcMain.handle('capture:copy', async (event, { cardIdx, archetype, filename } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const query = buildRecapExportQuery({ cardIdx, archetype, filename });
  const image = await createExportCapture(win, query);
  clipboard.writeImage(image);
  return true;
});

// --- Recap files ---

ipcMain.handle('recap:list', () => {
  if (!fs.existsSync(RECAP_DIR)) return [];
  return fs.readdirSync(RECAP_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();
});

ipcMain.handle('recap:read', (_, filename) => {
  const filePath = path.join(RECAP_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
});

// --- Settings ---

const SETTINGS_PATH = path.join(OBELISK_DIR, 'settings.json');

function loadPersistedSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {}
  return {};
}

function savePersistedSettings(settings) {
  if (!fs.existsSync(OBELISK_DIR)) fs.mkdirSync(OBELISK_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

ipcMain.handle('settings:get', () => {
  const persisted = loadPersistedSettings();
  const { claudeDir, codexDir, dbPath: dbFile } = getPathsForClaudeDir(
    persisted.claudeDir || DEFAULT_CLAUDE_DIR,
    persisted.codexDir || DEFAULT_CODEX_DIR,
  );
  const recapDir = persisted.recapDir || RECAP_DIR;
  const claudeExists = fs.existsSync(claudeDir);
  const codexExists = fs.existsSync(codexDir);
  let claudeSessionCount = 0;
  let codexSessionCount = 0;
  let memoryCount = 0;
  let claudeLastIndexed = '';
  let codexLastIndexed = '';

  if (db) {
    try {
      claudeSessionCount = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE COALESCE(source, 'claude') = 'claude'").get()?.c || 0;
      codexSessionCount = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE source = 'codex'").get()?.c || 0;
      memoryCount = db.prepare('SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL').get()?.c || 0;
      const claudeLatest = db.prepare("SELECT MAX(started_at) as t FROM sessions WHERE COALESCE(source, 'claude') = 'claude'").get();
      claudeLastIndexed = claudeLatest?.t || '';
      const codexLatest = db.prepare("SELECT MAX(started_at) as t FROM sessions WHERE source = 'codex'").get();
      codexLastIndexed = codexLatest?.t || '';
    } catch {}
  }

  return {
    claudeDir,
    codexDir,
    dbPath: dbFile,
    recapDir,
    autoRefresh: persisted.autoRefresh !== false,
    sources: [
      {
        id: 'claude',
        name: 'Claude Code',
        vendor: 'Anthropic',
        path: claudeDir,
        exists: claudeExists,
        sessionCount: claudeSessionCount,
        lastIndexed: claudeLastIndexed,
        status: claudeExists ? 'ok' : 'error',
        statusText: claudeExists ? 'Connected' : 'Folder not found',
      },
      {
        id: 'codex',
        name: 'Codex',
        vendor: 'OpenAI',
        path: codexDir,
        exists: codexExists,
        sessionCount: codexSessionCount,
        lastIndexed: codexLastIndexed,
        status: codexExists ? (codexSessionCount > 0 ? 'ok' : 'warn') : 'error',
        statusText: codexExists ? (codexSessionCount > 0 ? 'Connected' : 'No sessions found') : 'Folder not found',
      },
    ],
    memoryCount,
    sessionCount: claudeSessionCount + codexSessionCount,
    lastIndexed: claudeLastIndexed,
    status: claudeExists ? 'ok' : 'error',
    statusText: claudeExists ? 'Connected' : 'Folder not found',
  };
});

ipcMain.handle('settings:set', async (_, key, value) => {
  const persisted = loadPersistedSettings();
  if (value === null) {
    delete persisted[key];
  } else {
    persisted[key] = value;
  }
  savePersistedSettings(persisted);

  if (key === 'autoRefresh') {
    if (value === false && indexerService) {
      await stopIndexerServiceAndWait();
    } else if (value !== false && indexerService) {
      await stopIndexerServiceAndWait();
      startIndexerService({ buildOnStart: false });
    }
  }

  if (key === 'claudeDir' || key === 'codexDir') {
    await stopIndexerServiceAndWait();
    const paths = getPathsForClaudeDir(
      persisted.claudeDir || DEFAULT_CLAUDE_DIR,
      persisted.codexDir || DEFAULT_CODEX_DIR,
    );
    migrateLegacyDbIfNeeded(paths);
    openDb(paths.dbPath);
    if (persisted.autoRefresh !== false) {
      startIndexerService({ buildOnStart: true });
    }
    notifyIndexUpdated();
  }
  return true;
});

ipcMain.handle('settings:browseFolder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Select Claude Code data folder',
  });
  if (filePaths && filePaths[0]) return filePaths[0];
  return null;
});

ipcMain.handle('settings:revealPath', (_, p) => {
  const { shell } = require('electron');
  if (fs.existsSync(p)) shell.showItemInFolder(p);
});

ipcMain.handle('settings:rebuildIndex', async () => {
  if (!indexerWorker) return null;
  const persisted = loadPersistedSettings();
  const paths = getPathsForClaudeDir(
    persisted.claudeDir || DEFAULT_CLAUDE_DIR,
    persisted.codexDir || DEFAULT_CODEX_DIR,
  );
  const tempDbPath = rebuildTempDbPath(paths.dbPath);
  const shouldRestartWatcher = persisted.autoRefresh !== false;
  await stopIndexerServiceAndWait({ waitForIdle: false });
  if (indexerWorker) {
    await Promise.resolve(indexerWorker.stop());
    indexerWorker = createWorkerBuildIndex();
  }
  cleanupDbFiles(tempDbPath);
  try {
    migrateLegacyDbIfNeeded(paths);
    const result = await indexerWorker.buildIndex({
      reason: 'manual-rebuild',
      force: true,
      claudeDir: paths.claudeDir,
      codexDir: paths.codexDir,
      projectsDir: paths.projectsDir,
      dbPath: tempDbPath,
      preserveDbPath: fs.existsSync(paths.dbPath) ? paths.dbPath : null,
    });
    closeDb();
    replaceDbWithTemp(tempDbPath, paths.dbPath);
    openDb(paths.dbPath);
    notifyIndexUpdated(result);
    return result;
  } finally {
    cleanupDbFiles(tempDbPath);
    if (!db) {
      try {
        openDb(paths.dbPath);
      } catch (error) {
        console.warn?.(`Obelisk DB reopen after rebuild failed: ${error.message}`);
      }
    }
    if (shouldRestartWatcher) startIndexerService({ buildOnStart: false });
  }
});

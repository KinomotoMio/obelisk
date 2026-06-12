const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.claude', 'obelisk.sqlite');

let db;

function openDb() {
  if (!fs.existsSync(DB_PATH)) return null;
  db = new Database(DB_PATH, { readonly: false });
  db.pragma('journal_mode = WAL');
  return db;
}

function createWindow() {
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
    },
  });

  const isDev = process.argv.includes('--dev');
  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, 'dist-renderer', 'index.html'));
  }
}

app.whenReady().then(() => {
  openDb();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (db) db.close();
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

ipcMain.handle('db:getSessions', (_, opts = {}) => {
  if (!db) return [];
  const { project, limit = 200 } = opts;
  let sql = `SELECT id, title, project, project_path, started_at, ended_at, git_branch, version, message_count, jsonl_path FROM sessions`;
  const params = [];
  if (project) { sql += ` WHERE project LIKE ?`; params.push(project); }
  sql += ` ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
});

ipcMain.handle('db:getSessionMessages', (_, sessionId) => {
  if (!db) return [];
  return db.prepare(`
    SELECT m.uuid, m.session_id, m.type, m.parent_uuid, m.timestamp, m.role, m.text, m.model,
           m.is_sidechain, m.agent_id, m.input_tokens, m.output_tokens, m.cwd, m.skill, m.turn_duration_ms,
           m.content_type, m.is_meta
    FROM messages m WHERE m.session_id = ? AND m.agent_id IS NULL ORDER BY m.timestamp
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
           m.content_type, m.is_meta
    FROM messages m WHERE m.agent_id = ? ORDER BY m.timestamp
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
    SELECT id, session_id, project, message_start, message_end, path, summary, created_at, deleted_at, deleted_reason
    FROM memories ORDER BY created_at DESC
  `).all();
});

ipcMain.handle('db:getMessageFullText', (_, uuid) => {
  if (!db) return null;
  const msg = db.prepare('SELECT session_id, agent_id FROM messages WHERE uuid=?').get(uuid);
  if (!msg) return null;

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

ipcMain.handle('db:getProjects', () => {
  if (!db) return [];
  return db.prepare(`
    SELECT project, project_path, COUNT(*) as session_count,
           MAX(COALESCE(ended_at, started_at)) as last_active
    FROM sessions WHERE project IS NOT NULL
    GROUP BY project ORDER BY last_active DESC
  `).all();
});

ipcMain.handle('db:getStats', () => {
  if (!db) return { sessions: 0, memories: 0, memoriesArchived: 0 };
  const sessions = db.prepare('SELECT COUNT(*) as c FROM sessions').get()?.c || 0;
  const memories = db.prepare('SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL').get()?.c || 0;
  const memoriesArchived = db.prepare('SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NOT NULL').get()?.c || 0;
  return { sessions, memories, memoriesArchived };
});

ipcMain.handle('db:getUsageStats', () => {
  if (!db) return { daily: [], totalTokens: 0, peakDay: null, longestTurn: null };

  const daily = db.prepare(`
    SELECT DATE(timestamp) as day,
           SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) as tokens
    FROM messages
    WHERE timestamp IS NOT NULL AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
    GROUP BY DATE(timestamp)
    ORDER BY day
  `).all();

  const totalTokens = db.prepare(`
    SELECT SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) as total
    FROM messages
  `).get()?.total || 0;

  const peakDay = db.prepare(`
    SELECT DATE(timestamp) as day,
           SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) as tokens
    FROM messages
    WHERE timestamp IS NOT NULL AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
    GROUP BY DATE(timestamp)
    ORDER BY tokens DESC
    LIMIT 1
  `).get() || null;

  const longestTurn = db.prepare(`
    SELECT turn_duration_ms, uuid, session_id, timestamp
    FROM messages
    WHERE turn_duration_ms IS NOT NULL
    ORDER BY turn_duration_ms DESC
    LIMIT 1
  `).get() || null;

  return { daily, totalTokens, peakDay, longestTurn };
});

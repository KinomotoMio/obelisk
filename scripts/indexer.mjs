import { CLAUDE_DIR, CODEX_DIR, openDb, rebuildMemoryFts, isDir, readLines, fs, path } from './db.mjs';
import { persist } from './persist.ts';
import { parse as claudeParse } from './providers/claude.ts';
import { parse as codexParse } from './providers/codex.ts';

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HISTORY_PATH = path.join(CLAUDE_DIR, 'history.jsonl');
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');

function legacyProjectPathFromSlug(project) {
  if (!project) return null;
  return '/' + project.replace(/-/g, '/').replace(/^\//, '');
}

function normalizeObservedCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim() || !path.isAbsolute(cwd)) return null;
  return path.normalize(cwd);
}

function projectSlugFromPath(projectPath) {
  const normalized = normalizeObservedCwd(projectPath);
  if (!normalized) return null;
  return '-' + normalized.replace(/^[\\/]+/, '').replace(/[\\/]+/g, '-');
}

function inferProjectPath(project, observedCwds = []) {
  const byPath = new Map();
  for (const cwd of observedCwds) {
    const normalized = normalizeObservedCwd(cwd);
    if (!normalized) continue;
    const current = byPath.get(normalized) || { path: normalized, count: 0, first: byPath.size };
    current.count++;
    byPath.set(normalized, current);
  }
  const best = [...byPath.values()].sort((a, b) => b.count - a.count || a.first - b.first)[0];
  return best?.path || legacyProjectPathFromSlug(project);
}

function discoverJsonlFiles() {
  const files = [];
  if (!fs.existsSync(PROJECTS_DIR)) return files;
  let projects;
  try { projects = fs.readdirSync(PROJECTS_DIR); } catch (e) { process.stderr.write(`Warning: cannot read projects dir: ${e.message}\n`); return files; }
  for (const proj of projects) {
    const projPath = path.join(PROJECTS_DIR, proj);
    if (!isDir(projPath)) continue;
    let entries;
    try { entries = fs.readdirSync(projPath); } catch { continue; }
    for (const f of entries) {
      if (f.endsWith('.jsonl'))
        files.push({ path: path.join(projPath, f), sessionId: f.slice(0, -6), project: proj, isSubagent: false });
    }
    for (const sd of entries) {
      const saDir = path.join(projPath, sd, 'subagents');
      if (!isDir(saDir)) continue;
      let saEntries;
      try { saEntries = fs.readdirSync(saDir); } catch { continue; }
      for (const sf of saEntries) {
        if (sf.endsWith('.jsonl'))
          files.push({ path: path.join(saDir, sf), sessionId: sd, project: proj, isSubagent: true, agentId: sf.slice(0, -6) });
      }
      const wfRoot = path.join(saDir, 'workflows');
      if (!isDir(wfRoot)) continue;
      let wfDirs;
      try { wfDirs = fs.readdirSync(wfRoot); } catch { continue; }
      for (const wfDir of wfDirs) {
        const wfPath = path.join(wfRoot, wfDir);
        if (!isDir(wfPath)) continue;
        let wfEntries;
        try { wfEntries = fs.readdirSync(wfPath); } catch { continue; }
        for (const wf of wfEntries) {
          if (wf.endsWith('.jsonl'))
            files.push({ path: path.join(wfPath, wf), sessionId: sd, project: proj, isSubagent: true, agentId: wf.slice(0, -6), workflowRunId: wfDir });
        }
      }
    }
  }
  return files;
}

function discoverCodexJsonlFiles() {
  const files = [];
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return files;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fp);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({ path: fp, source: 'codex' });
      }
    }
  };
  walk(CODEX_SESSIONS_DIR);
  return files;
}

function needsReindex(db, fp) {
  const mt = fs.statSync(fp).mtimeMs;
  const row = db.prepare('SELECT mtime, lines_processed FROM index_state WHERE jsonl_path = ?').get(fp);
  if (!row) return { needed: true, skip: 0 };
  return mt > row.mtime ? { needed: true, skip: row.lines_processed } : { needed: false, skip: 0 };
}

function codexDbId(id) {
  if (!id) return null;
  const raw = String(id).replace(/^codex:/, '');
  return `codex:${raw}`;
}

function codexRawId(id) {
  return id ? String(id).replace(/^codex:/, '') : null;
}

function codexLineUuid(threadId, lineNum) {
  return `codex:${codexRawId(threadId)}:${String(lineNum).padStart(6, '0')}`;
}

function codexCallId(callId) {
  if (!callId) return null;
  return `codex:${String(callId).replace(/^codex:/, '')}`;
}

function codexParentThreadId(meta) {
  const subagent = meta?.source?.subagent;
  return subagent?.thread_spawn?.parent_thread_id
    || meta?.forked_from_id
    || subagent?.parent_thread_id
    || null;
}

function codexIsGuardianThread(meta, records = []) {
  const subagent = meta?.source?.subagent;
  if (subagent?.other === 'guardian') return true;
  if (meta?.thread_source !== 'subagent') return false;
  return records.some(({ obj }) => obj?.payload?.model === 'codex-auto-review' || obj?.model === 'codex-auto-review');
}

function readCodexGuardianThreadInfo(filePath) {
  const records = [];
  let metaRecord = null;
  let lineNum = 0;
  readLines(filePath, (line) => {
    lineNum++;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    records.push({ lineNum, obj });
    if (obj?.type === 'session_meta' && obj.payload?.id) {
      metaRecord = { lineNum, obj };
      if (obj.payload?.source?.subagent?.other === 'guardian') return false;
      if (obj.payload?.thread_source !== 'subagent') return false;
    }
    if (metaRecord && codexIsGuardianThread(metaRecord.obj.payload, records)) return false;
  });
  const meta = metaRecord?.obj?.payload;
  if (!meta || !codexIsGuardianThread(meta, records)) return null;
  return { threadRawId: codexRawId(meta.id), lineNum };
}

function codexAgentNickname(meta) {
  return meta?.agent_nickname
    || meta?.source?.subagent?.thread_spawn?.agent_nickname
    || null;
}

function codexAgentRole(meta) {
  return meta?.agent_role
    || meta?.source?.subagent?.thread_spawn?.agent_role
    || null;
}

function parseCodexJsonInput(value) {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function codexUsage(payload) {
  const usage = payload?.info?.last_token_usage || payload?.info?.total_token_usage || payload?.last_token_usage || null;
  if (!usage) return {};
  return {
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
  };
}

function codexEventText(payload) {
  if (typeof payload?.message === 'string') return payload.message;
  if (Array.isArray(payload?.text_elements) && payload.text_elements.length) {
    const parts = payload.text_elements.map(item => typeof item === 'string' ? item : item?.text).filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  if (typeof payload?.text === 'string') return payload.text;
  return null;
}

function codexMessagePayloadText(payload) {
  if (!Array.isArray(payload?.content)) return null;
  const parts = [];
  for (const block of payload.content) {
    if (typeof block?.text === 'string') parts.push(block.text);
  }
  return parts.length ? parts.join('\n') : null;
}

function codexVisibleMessageKey(role, text) {
  return `${role || ''}\u0000${text || ''}`;
}

function codexToolInput(payload) {
  if (payload?.type === 'custom_tool_call') return parseCodexJsonInput(payload.input);
  if (payload?.type === 'tool_search_call') return parseCodexJsonInput(payload.arguments);
  if (payload?.type === 'web_search_call') return { action: payload.action || null };
  return parseCodexJsonInput(payload?.arguments);
}

function codexToolOutput(payload) {
  if (typeof payload?.output === 'string') return payload.output;
  if (payload?.output !== undefined) return JSON.stringify(payload.output);
  if (payload?.tools !== undefined) return JSON.stringify(payload.tools);
  if (payload?.execution !== undefined) return JSON.stringify(payload.execution);
  return null;
}

function indexCodexSessionIndex(db) {
  const indexPath = path.join(CODEX_DIR, 'session_index.jsonl');
  if (!fs.existsSync(indexPath)) return;
  readLines(indexPath, (line) => {
    try {
      const item = JSON.parse(line);
      if (!item.id || !item.thread_name) return;
      db.prepare('UPDATE sessions SET title=COALESCE(title, ?), ended_at=COALESCE(ended_at, ?) WHERE id=? AND source=?')
        .run(item.thread_name, item.updated_at || null, codexDbId(item.id), 'codex');
    } catch (e) {
      process.stderr.write(`Warning: malformed Codex session index line: ${e.message}\n`);
    }
  });
}

function refreshSessionProjectPaths(db) {
  const sessions = db.prepare('SELECT id, project FROM sessions').all();
  const cwdStmt = db.prepare(`
    SELECT cwd
    FROM messages
    WHERE session_id = ? AND cwd IS NOT NULL AND cwd != ''
    ORDER BY timestamp IS NULL, timestamp
  `);
  const update = db.prepare('UPDATE sessions SET project_path = ? WHERE id = ?');
  for (const session of sessions) {
    const cwds = cwdStmt.all(session.id).map(row => row.cwd);
    const projectPath = inferProjectPath(session.project, cwds);
    if (projectPath) update.run(projectPath, session.id);
  }
}

function indexSubagentMeta(db, fi) {
  if (!fi.isSubagent) return;
  const mp = fi.path.replace('.jsonl', '.meta.json');
  if (!fs.existsSync(mp)) return;
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const tok = db.prepare('SELECT COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) as t FROM messages WHERE agent_id=?').get(fi.agentId);
    const ts = db.prepare('SELECT MIN(timestamp) as t0, MAX(timestamp) as t1 FROM messages WHERE agent_id=?').get(fi.agentId);
    const dur = ts?.t0 && ts?.t1 ? new Date(ts.t1).getTime() - new Date(ts.t0).getTime() : null;
    if (fi.workflowRunId) {
      db.prepare('INSERT OR REPLACE INTO workflow_agents (agent_id,run_id,session_id,agent_type,description) VALUES(?,?,?,?,?)').run(fi.agentId, fi.workflowRunId, fi.sessionId, meta.agentType||null, meta.description||null);
    } else {
      db.prepare('INSERT OR REPLACE INTO subagents VALUES(?,?,?,?,?,?,?)').run(fi.agentId, fi.sessionId, meta.toolUseId||null, meta.agentType||null, meta.description||null, dur, tok?.t||0);
    }
  } catch (e) { process.stderr.write(`Warning: failed to read subagent meta ${mp}: ${e.message}\n`); }
}

function indexWorkflows(db) {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  let projects;
  try { projects = fs.readdirSync(PROJECTS_DIR); } catch { return; }
  for (const proj of projects) {
    const pp = path.join(PROJECTS_DIR, proj);
    if (!isDir(pp)) continue;
    let entries;
    try { entries = fs.readdirSync(pp); } catch { continue; }
    for (const sd of entries) {
      const wd = path.join(pp, sd, 'workflows');
      if (!isDir(wd)) continue;
      let wfFiles;
      try { wfFiles = fs.readdirSync(wd); } catch { continue; }
      for (const f of wfFiles) {
        if (!f.endsWith('.json')) continue;
        try {
          const wf = JSON.parse(fs.readFileSync(path.join(wd, f), 'utf8'));
          if (!wf.runId) continue;
          const ac = db.prepare('SELECT COUNT(*) as c FROM workflow_agents WHERE run_id=?').get(wf.runId);
          db.prepare('INSERT OR REPLACE INTO workflows (run_id,session_id,task_id,script,result_json,timestamp,agent_count,duration_ms,total_tokens,status,workflow_name) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
            wf.runId, sd, wf.taskId||null, wf.script||null,
            wf.result ? JSON.stringify(wf.result) : null, wf.timestamp||null, ac?.c||0,
            wf.durationMs||null, wf.totalTokens||null, wf.status||null, wf.workflowName||null);
          const progress = wf.workflowProgress || [];
          for (const item of progress) {
            if (item.type !== 'workflow_agent' || !item.agentId) continue;
            db.prepare('UPDATE workflow_agents SET phase=?, label=?, model=?, state=?, duration_ms=?, tokens=?, tool_calls=? WHERE agent_id=?').run(
              item.phaseTitle||null, item.label||null, item.model||null, item.state||null,
              item.durationMs||null, item.tokens||null, item.toolCalls||null, 'agent-' + item.agentId);
          }
        } catch (e) { process.stderr.write(`Warning: failed to index workflow ${f}: ${e.message}\n`); }
      }
    }
  }
}

function indexHistory(db) {
  if (!fs.existsSync(HISTORY_PATH)) return;
  readLines(HISTORY_PATH, (line) => {
    try {
      const o = JSON.parse(line);
      if (o.sessionId && o.title) db.prepare('UPDATE sessions SET title=? WHERE id=? AND title IS NULL').run(o.title, o.sessionId);
    } catch (e) { process.stderr.write(`Warning: malformed history line: ${e.message}\n`); }
  });
}

const BUILD_DEBOUNCE_MS = 30000;
const APP_HEARTBEAT_FRESH_MS = 60000;

function shouldSkipBuild(db, { now = Date.now() } = {}) {
  const appHeartbeat = db.prepare("SELECT mtime FROM index_state WHERE jsonl_path='__app_heartbeat__'").get();
  const appSuccessfulBuild = db.prepare("SELECT mtime FROM index_state WHERE jsonl_path='__app_last_successful_build__'").get();
  if (
    appHeartbeat && now - appHeartbeat.mtime < APP_HEARTBEAT_FRESH_MS &&
    appSuccessfulBuild && now - appSuccessfulBuild.mtime < APP_HEARTBEAT_FRESH_MS
  ) {
    return { skip: true, reason: 'app_successful_build' };
  }
  const last = db.prepare("SELECT mtime FROM index_state WHERE jsonl_path='__last_build__'").get();
  if (last && now - last.mtime < BUILD_DEBOUNCE_MS) {
    return { skip: true, reason: 'recent_build' };
  }
  return { skip: false };
}

// A one-shot record stream that retracts a session, for routing guardian sweeps
// through persist (the single db writer) instead of deleting rows directly.
function* guardianDelete(sessionId) {
  yield { kind: 'delete-session', sessionId };
  return null;
}

function buildIndex({ force = false } = {}) {
  const db = openDb();
  if (!force) {
    const skip = shouldSkipBuild(db);
    if (skip.skip) { db.close(); return; }
  }

  if (force) {
    db.prepare("DELETE FROM index_state WHERE jsonl_path != '__last_build__'").run();
  }

  const files = [
    ...discoverJsonlFiles(),
    ...discoverCodexJsonlFiles(),
  ];
  for (const f of files) {
    db.exec('BEGIN');
    try {
      if (f.source === 'codex') {
        // Codex goes through the pure adapter + shared persist (docs/adr/0001),
        // full-reparse (countMode 'total') when the file changed. An unchanged
        // file is not reparsed, but is still swept for stale guardian rows: a
        // guardian/auto-review thread must never linger in the index, even if it
        // was indexed before guardian detection removed it.
        const { needed } = needsReindex(db, f.path);
        if (needed) {
          persist(db, { key: f.path, sessionId: '' }, codexParse({ key: f.path, sessionId: '' }, null));
        } else {
          const guardian = readCodexGuardianThreadInfo(f.path);
          if (guardian) {
            persist(db, { key: f.path, sessionId: '' }, guardianDelete(codexDbId(guardian.threadRawId)));
          }
        }
      } else {
        // Claude transcripts now go through the pure adapter + shared persist
        // (docs/adr/0001). needsReindex keeps the "skip unchanged file" fast path;
        // the cursor's line count drives incremental resume inside parse().
        const { needed, skip } = needsReindex(db, f.path);
        if (needed) {
          const unit = { key: f.path, sessionId: f.sessionId, project: f.project, isSubagent: f.isSubagent, agentId: f.agentId };
          persist(db, unit, claudeParse(unit, skip > 0 ? `0:${skip}` : null));
        }
        indexSubagentMeta(db, f);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      process.stderr.write(`Warning: failed to index ${f.path}: ${e.message}\n`);
    }
  }
  db.exec('BEGIN');
  try {
    indexWorkflows(db);
    refreshSessionProjectPaths(db);
    indexHistory(db);
    indexCodexSessionIndex(db);
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    rebuildMemoryFts(db);
    db.prepare("INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES ('__last_build__', ?, 0)").run(Date.now());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    process.stderr.write(`Warning: failed to finalize index: ${e.message}\n`);
  }
  db.close();
}

export {
  buildIndex, discoverJsonlFiles, inferProjectPath, refreshSessionProjectPaths, shouldSkipBuild,
  // Pure codex helpers consumed by providers/codex.ts (temporary export; they
  // move into codex.ts once indexCodexJsonl is removed in the 5c cleanup).
  discoverCodexJsonlFiles, normalizeObservedCwd, projectSlugFromPath,
  codexRawId, codexDbId, codexCallId, codexLineUuid, codexParentThreadId,
  codexIsGuardianThread, codexAgentNickname, codexAgentRole, codexUsage,
  codexEventText, codexMessagePayloadText, codexVisibleMessageKey,
  codexToolInput, codexToolOutput,
};

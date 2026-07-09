import { openDb, rebuildMemoryFts } from './db.mjs';
import {
  CLAUDE_DIR, CODEX_DIR, PROJECTS_DIR, fs, path, isDir, readLines,
  inferProjectPath, discoverJsonlFiles, discoverCodexJsonlFiles, codexDbId, readCodexGuardianThreadInfo,
} from './parsing.mjs';
import { persist } from './persist.ts';
import { parse as claudeParse } from './providers/claude.ts';
import { parse as codexParse } from './providers/codex.ts';

const HISTORY_PATH = path.join(CLAUDE_DIR, 'history.jsonl');


function needsReindex(db, fp) {
  const mt = fs.statSync(fp).mtimeMs;
  const row = db.prepare('SELECT mtime, lines_processed FROM index_state WHERE jsonl_path = ?').get(fp);
  if (!row) return { needed: true, skip: 0 };
  return mt > row.mtime ? { needed: true, skip: row.lines_processed } : { needed: false, skip: 0 };
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

export { buildIndex, inferProjectPath, refreshSessionProjectPaths, shouldSkipBuild };

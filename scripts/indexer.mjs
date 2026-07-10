import { DB_PATH, openDb, openReadDb, openWriterLeaseDb, rebuildMemoryFts } from './db.mjs';
import {
  CLAUDE_DIR, CODEX_DIR, PROJECTS_DIR, fs, path, isDir, readLines,
  inferProjectPath, discoverJsonlFiles, discoverCodexJsonlFiles, codexDbId, readCodexGuardianThreadInfo,
} from './parsing.mjs';
import { persist } from './persist.ts';
import { nodeSqliteTransactionAdapter } from './tx.ts';
import { acquireWriterLease, writerLockPathFor } from './writer-lease.ts';
import { runRetryableWriteTransaction, isBeginBusyFailure, hasUnusableTransaction } from './write-coordinator.ts';
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
    let item;
    try {
      item = JSON.parse(line);
    } catch (e) {
      process.stderr.write(`Warning: malformed Codex session index line: ${e.message}\n`);
      return;
    }
    if (!item.id || !item.thread_name) return;
    db.prepare('UPDATE sessions SET title=COALESCE(title, ?), ended_at=COALESCE(ended_at, ?) WHERE id=? AND source=?')
      .run(item.thread_name, item.updated_at || null, codexDbId(item.id), 'codex');
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
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  } catch (e) {
    process.stderr.write(`Warning: failed to read subagent meta ${mp}: ${e.message}\n`);
    return;
  }
  const tok = db.prepare('SELECT COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) as t FROM messages WHERE agent_id=?').get(fi.agentId);
  const ts = db.prepare('SELECT MIN(timestamp) as t0, MAX(timestamp) as t1 FROM messages WHERE agent_id=?').get(fi.agentId);
  const dur = ts?.t0 && ts?.t1 ? new Date(ts.t1).getTime() - new Date(ts.t0).getTime() : null;
  if (fi.workflowRunId) {
    db.prepare('INSERT OR REPLACE INTO workflow_agents (agent_id,run_id,session_id,agent_type,description) VALUES(?,?,?,?,?)').run(fi.agentId, fi.workflowRunId, fi.sessionId, meta.agentType||null, meta.description||null);
  } else {
    db.prepare('INSERT OR REPLACE INTO subagents VALUES(?,?,?,?,?,?,?)').run(fi.agentId, fi.sessionId, meta.toolUseId||null, meta.agentType||null, meta.description||null, dur, tok?.t||0);
  }
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
        let wf;
        try {
          wf = JSON.parse(fs.readFileSync(path.join(wd, f), 'utf8'));
        } catch (e) {
          process.stderr.write(`Warning: failed to read workflow ${f}: ${e.message}\n`);
          continue;
        }
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
      }
    }
  }
}

function indexHistory(db) {
  if (!fs.existsSync(HISTORY_PATH)) return;
  readLines(HISTORY_PATH, (line) => {
    let item;
    try {
      item = JSON.parse(line);
    } catch (e) {
      process.stderr.write(`Warning: malformed history line: ${e.message}\n`);
      return;
    }
    if (item.sessionId && item.title) db.prepare('UPDATE sessions SET title=? WHERE id=? AND title IS NULL').run(item.title, item.sessionId);
  });
}

const BUILD_DEBOUNCE_MS = 30000;
const APP_HEARTBEAT_FRESH_MS = 60000;

function shouldSkipBuild(db, { now = Date.now(), ignoreRecentBuild = false } = {}) {
  const appHeartbeat = db.prepare("SELECT mtime FROM index_state WHERE jsonl_path='__app_heartbeat__'").get();
  if (appHeartbeat && now - appHeartbeat.mtime < APP_HEARTBEAT_FRESH_MS) {
    return { skip: true, reason: 'daemon_active' };
  }
  if (!ignoreRecentBuild) {
    const last = db.prepare("SELECT mtime FROM index_state WHERE jsonl_path='__last_build__'").get();
    if (last && now - last.mtime < BUILD_DEBOUNCE_MS) {
      return { skip: true, reason: 'recent_build' };
    }
  }
  return { skip: false };
}

function isMissingIndexStateTable(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:\s*(?:main\.)?index_state\b/i.test(message);
}

function inspectBuildOwnership({ force = false } = {}) {
  if (!fs.existsSync(DB_PATH)) return { skip: false };
  const db = openReadDb();
  try {
    return shouldSkipBuild(db, { ignoreRecentBuild: force });
  } catch (error) {
    // A missing table means the write path must initialize a new/legacy index.
    // Any other read failure leaves daemon ownership unknown, so fail closed.
    if (isMissingIndexStateTable(error)) return { skip: false };
    throw error;
  } finally {
    db.close();
  }
}

// A one-shot record stream that retracts a session, for routing guardian sweeps
// through persist (the single db writer) instead of deleting rows directly.
function* guardianDelete(sessionId) {
  yield { kind: 'delete-session', sessionId };
  return null;
}

function buildIndex({ force = false } = {}) {
  const ownership = inspectBuildOwnership({ force });
  if (ownership.skip) return ownership;
  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(DB_PATH),
    openDb: openWriterLeaseDb,
  });
  if (!lease) return { skip: true, reason: 'writer_busy' };
  try {
    // Ownership may change between the first read and lease acquisition.
    const ownershipAfterLease = inspectBuildOwnership({ force });
    if (ownershipAfterLease.skip) return ownershipAfterLease;

    const db = openDb();
    const txDb = nodeSqliteTransactionAdapter(db);
    const skippedFiles = [];
    try {
      try {
        if (force) {
          runRetryableWriteTransaction(txDb, () => {
            db.prepare("DELETE FROM index_state WHERE jsonl_path != '__last_build__'").run();
            // Clearing index_state alone re-indexes existing files but leaves rows for
            // files that no longer exist on disk (stale sessions accumulate). A force
            // build is a clean rebuild: drop every derived table, then re-index from the
            // current files. `memories` is the durable, human-approved layer and is never
            // cleared; messages_fts is repopulated by the 'rebuild' command in finalize.
            for (const table of ['messages', 'tool_calls', 'tool_results', 'sessions', 'summaries', 'subagents', 'workflows', 'workflow_agents']) {
              db.prepare(`DELETE FROM ${table}`).run();
            }
          }, { label: 'force-cleanup' });
        }
      } catch (error) {
        if (isBeginBusyFailure(error)) {
          return { skip: true, reason: 'database_busy', skipped: skippedFiles.length, skippedFiles };
        }
        throw error;
      }

      const files = [
        ...discoverJsonlFiles(),
        ...discoverCodexJsonlFiles(),
      ];
      for (const f of files) {
        try {
          runRetryableWriteTransaction(txDb, () => {
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
          }, { label: `file:${f.path}` });
        } catch (e) {
          if (isBeginBusyFailure(e)) {
            return { skip: true, reason: 'database_busy', skipped: skippedFiles.length, skippedFiles };
          }
          if (hasUnusableTransaction(e)) throw e;
          // A per-file failure is skippable: log and move on.
          skippedFiles.push({ path: f.path, error: e.message, diagnostics: e.obelisk });
          process.stderr.write(`Warning: failed to index ${f.path}: ${e.message}\n`);
        }
      }
      // Finalize is one transaction and is NOT swallowed: a finalize failure fails
      // the build (a half-finalized index would be inconsistent).
      try {
        runRetryableWriteTransaction(txDb, () => {
          indexWorkflows(db);
          refreshSessionProjectPaths(db);
          indexHistory(db);
          indexCodexSessionIndex(db);
          db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
          rebuildMemoryFts(db);
          db.prepare("INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES ('__last_build__', ?, 0)").run(Date.now());
        }, { label: 'finalize' });
      } catch (error) {
        if (isBeginBusyFailure(error)) {
          return { skip: true, reason: 'database_busy', skipped: skippedFiles.length, skippedFiles };
        }
        throw error;
      }
      return { skip: false, skipped: skippedFiles.length, skippedFiles };
    } finally {
      db.close();
    }
  } finally {
    lease.release();
  }
}

export { buildIndex, inferProjectPath, refreshSessionProjectPaths, shouldSkipBuild };

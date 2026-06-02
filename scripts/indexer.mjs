import { CLAUDE_DIR, openDb, trunc, truncJson, extractText, filePath, isDir, readLines, fs, path } from './db.mjs';

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HISTORY_PATH = path.join(CLAUDE_DIR, 'history.jsonl');

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

function needsReindex(db, fp) {
  const mt = fs.statSync(fp).mtimeMs;
  const row = db.prepare('SELECT mtime, lines_processed FROM index_state WHERE jsonl_path = ?').get(fp);
  if (!row) return { needed: true, skip: 0 };
  return mt > row.mtime ? { needed: true, skip: row.lines_processed } : { needed: false, skip: 0 };
}

function indexJsonl(db, fi) {
  const { needed, skip } = needsReindex(db, fi.path);
  if (!needed) return;
  const mt = fs.statSync(fi.path).mtimeMs;

  const ins = {
    ses: db.prepare('INSERT OR REPLACE INTO sessions (id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path) VALUES (?,?,?,?,?,?,?,?,?,?)'),
    msg: db.prepare('INSERT OR REPLACE INTO messages (uuid,session_id,type,parent_uuid,timestamp,role,text,model,is_sidechain,agent_id,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),
    tc:  db.prepare('INSERT OR REPLACE INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path) VALUES (?,?,?,?,?,?)'),
    tr:  db.prepare('INSERT OR REPLACE INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path,is_error) VALUES (?,?,?,?,?,?)'),
    sum: db.prepare('INSERT OR REPLACE INTO summaries (id,session_id,timestamp,source,content) VALUES (?,?,?,?,?)'),
    idx: db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,?,?)'),
  };

  const existing = !fi.isSubagent ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(fi.sessionId) : null;
  const sm = {
    started_at: existing?.started_at || null,
    ended_at: existing?.ended_at || null,
    git_branch: existing?.git_branch || null,
    version: existing?.version || null,
    title: existing?.title || null,
    n: existing?.message_count || 0,
  };

  let lineNum = 0;
  readLines(fi.path, (line) => {
    lineNum++;
    if (lineNum <= skip) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    const sid = fi.sessionId;
    const ts = obj.timestamp || null;

    if (obj.type === 'ai-title' && obj.aiTitle) { sm.title = obj.aiTitle; return; }
    if (obj.type === 'system' && obj.subtype === 'away_summary' && obj.content) {
      ins.sum.run(obj.uuid || `${sid}-away-${ts}`, sid, ts, 'away_summary', obj.content);
      return;
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') return;

    if (ts && (!sm.started_at || ts < sm.started_at)) sm.started_at = ts;
    if (ts && (!sm.ended_at || ts > sm.ended_at)) sm.ended_at = ts;
    if (obj.gitBranch) sm.git_branch = obj.gitBranch;
    if (obj.version) sm.version = obj.version;
    sm.n++;

    const msg = obj.message || {};
    const text = extractText(msg.content);
    const usage = msg.usage || {};
    const aid = fi.isSubagent ? fi.agentId : (obj.agentId || null);

    if (obj.uuid) {
      ins.msg.run(obj.uuid, sid, obj.type, obj.parentUuid || null, ts,
        msg.role || obj.type, text, msg.model || null,
        obj.isSidechain ? 1 : 0, aid, usage.input_tokens || null, usage.output_tokens || null);
    }

    if (obj.type === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use' && b.id)
          ins.tc.run(b.id, obj.uuid, sid, b.name, truncJson(b.input || {}), filePath(b.name, b.input));
      }
    }

    if (obj.type === 'user' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const rt = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map(c => c.text || '').join('\n') : '';
        ins.tr.run(b.tool_use_id, obj.uuid, sid, trunc(rt), obj.toolUseResult?.filePath || null, b.is_error ? 1 : 0);
      }
    }
  });

  if (!fi.isSubagent) {
    const pp = '/' + fi.project.replace(/-/g, '/').replace(/^\//, '');
    ins.ses.run(fi.sessionId, sm.title, fi.project, pp, sm.started_at, sm.ended_at, sm.git_branch, sm.version, sm.n, fi.path);
  }
  ins.idx.run(fi.path, mt, lineNum);
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
      db.prepare('INSERT OR REPLACE INTO workflow_agents VALUES(?,?,?,?,?)').run(fi.agentId, fi.workflowRunId, fi.sessionId, meta.agentType||null, meta.description||null);
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
          db.prepare('INSERT OR REPLACE INTO workflows VALUES(?,?,?,?,?,?,?)').run(
            wf.runId, sd, wf.taskId||null, wf.script||null,
            wf.result ? JSON.stringify(wf.result) : null, wf.timestamp||null, ac?.c||0);
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

function buildIndex() {
  const db = openDb();
  const files = discoverJsonlFiles();
  for (const f of files) {
    db.exec('BEGIN');
    try {
      indexJsonl(db, f);
      indexSubagentMeta(db, f);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      process.stderr.write(`Warning: failed to index ${f.path}: ${e.message}\n`);
    }
  }
  db.exec('BEGIN');
  try {
    indexWorkflows(db);
    indexHistory(db);
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    process.stderr.write(`Warning: failed to finalize index: ${e.message}\n`);
  }
  db.close();
}

export { buildIndex };

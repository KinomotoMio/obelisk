import { CLAUDE_DIR, CODEX_DIR, openDb, rebuildMemoryFts, trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, filePath, isDir, readLines, fs, path } from './db.mjs';

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

function indexJsonl(db, fi) {
  const { needed, skip } = needsReindex(db, fi.path);
  if (!needed) return;
  const mt = fs.statSync(fi.path).mtimeMs;

  const ins = {
    ses: db.prepare('INSERT OR REPLACE INTO sessions (id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    msg: db.prepare('INSERT OR REPLACE INTO messages (uuid,session_id,type,parent_uuid,timestamp,role,text,content_type,is_meta,model,is_sidechain,agent_id,input_tokens,output_tokens,cwd,skill,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
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
    cwds: [],
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
    if (obj.type === 'system' && obj.subtype === 'turn_duration' && obj.parentUuid && obj.durationMs) {
      db.prepare('UPDATE messages SET turn_duration_ms=? WHERE uuid=?').run(obj.durationMs, obj.parentUuid);
      return;
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') return;

    if (ts && (!sm.started_at || ts < sm.started_at)) sm.started_at = ts;
    if (ts && (!sm.ended_at || ts > sm.ended_at)) sm.ended_at = ts;
    if (obj.gitBranch) sm.git_branch = obj.gitBranch;
    if (obj.version) sm.version = obj.version;
    sm.n++;
    if (!fi.isSubagent && obj.cwd) sm.cwds.push(obj.cwd);

    const msg = obj.message || {};
    const text = extractText(msg.content);
    const contentType = extractContentType(msg.content);
    const isMeta = extractMessageIsMeta(obj, text);
    const usage = msg.usage || {};
    const aid = fi.isSubagent ? fi.agentId : (obj.agentId || null);

    if (obj.uuid) {
      ins.msg.run(obj.uuid, sid, obj.type, obj.parentUuid || null, ts,
        msg.role || obj.type, text, contentType, isMeta, msg.model || null,
        obj.isSidechain ? 1 : 0, aid, usage.input_tokens || null, usage.output_tokens || null,
        obj.cwd || null, obj.attributionSkill || null, 'claude');
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
    const pp = inferProjectPath(fi.project, sm.cwds);
    ins.ses.run(fi.sessionId, sm.title, fi.project, pp, sm.started_at, sm.ended_at, sm.git_branch, sm.version, sm.n, fi.path, 'claude');
  }
  ins.idx.run(fi.path, mt, lineNum);
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

function deleteCodexThreadRows(db, threadRawId) {
  const threadId = codexDbId(threadRawId);
  if (!threadId) return;
  db.prepare(`
    DELETE FROM tool_results
    WHERE session_id = ?
       OR message_uuid IN (SELECT uuid FROM messages WHERE session_id = ? OR agent_id = ?)
  `).run(threadId, threadId, threadId);
  db.prepare(`
    DELETE FROM tool_calls
    WHERE session_id = ?
       OR message_uuid IN (SELECT uuid FROM messages WHERE session_id = ? OR agent_id = ?)
  `).run(threadId, threadId, threadId);
  db.prepare('DELETE FROM messages WHERE session_id = ? OR agent_id = ?').run(threadId, threadId);
  db.prepare('DELETE FROM subagents WHERE agent_id = ? OR session_id = ?').run(threadId, threadId);
  db.prepare('DELETE FROM summaries WHERE session_id = ?').run(threadId);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(threadId);
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

function upsertCodexSubagent(db, {
  agentId,
  sessionId,
  parentToolUseId = null,
  agentType = null,
  description = null,
  durationMs = null,
  totalTokens = null,
} = {}) {
  if (!agentId || !sessionId) return;
  db.prepare(`
    INSERT INTO subagents (agent_id,session_id,parent_tool_use_id,agent_type,description,duration_ms,total_tokens)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(agent_id) DO UPDATE SET
      session_id=excluded.session_id,
      parent_tool_use_id=COALESCE(excluded.parent_tool_use_id, subagents.parent_tool_use_id),
      agent_type=COALESCE(excluded.agent_type, subagents.agent_type),
      description=COALESCE(excluded.description, subagents.description),
      duration_ms=COALESCE(excluded.duration_ms, subagents.duration_ms),
      total_tokens=COALESCE(excluded.total_tokens, subagents.total_tokens)
  `).run(agentId, sessionId, parentToolUseId, agentType, description, durationMs, totalTokens);
}

function indexCodexJsonl(db, fi) {
  const state = needsReindex(db, fi.path);
  if (!state.needed) {
    const guardian = readCodexGuardianThreadInfo(fi.path);
    if (guardian) deleteCodexThreadRows(db, guardian.threadRawId);
    return;
  }
  const mt = fs.statSync(fi.path).mtimeMs;
  const records = [];
  let lineNum = 0;
  readLines(fi.path, (line) => {
    lineNum++;
    try {
      records.push({ lineNum, obj: JSON.parse(line) });
    } catch {}
  });

  const metaRecord = records.find(r => r.obj?.type === 'session_meta' && r.obj.payload?.id);
  if (!metaRecord) {
    db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,?,?)').run(fi.path, mt, lineNum);
    return;
  }

  const meta = metaRecord.obj.payload;
  const threadRawId = codexRawId(meta.id);
  if (codexIsGuardianThread(meta, records)) {
    deleteCodexThreadRows(db, threadRawId);
    db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,?,?)').run(fi.path, mt, lineNum);
    return;
  }
  const parentRawId = codexParentThreadId(meta);
  const sessionId = codexDbId(parentRawId || threadRawId);
  const agentId = parentRawId ? codexDbId(threadRawId) : null;
  const isSidechain = agentId ? 1 : 0;
  const projectPath = normalizeObservedCwd(meta.cwd);
  const project = projectSlugFromPath(projectPath);
  const sm = {
    started_at: meta.timestamp || metaRecord.obj.timestamp || null,
    ended_at: meta.timestamp || metaRecord.obj.timestamp || null,
    git_branch: meta.git?.branch || null,
    version: meta.cli_version || null,
    title: null,
    n: 0,
    cwds: projectPath ? [projectPath] : [],
    lastMessageUuid: null,
    lastTextAssistantUuid: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  const ins = {
    ses: db.prepare('INSERT OR REPLACE INTO sessions (id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    msg: db.prepare(`
      INSERT INTO messages (uuid,session_id,type,parent_uuid,timestamp,role,text,content_type,is_meta,model,is_sidechain,agent_id,input_tokens,output_tokens,cwd,skill,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(uuid) DO UPDATE SET
        session_id=excluded.session_id,
        type=excluded.type,
        parent_uuid=excluded.parent_uuid,
        timestamp=excluded.timestamp,
        role=excluded.role,
        text=excluded.text,
        content_type=excluded.content_type,
        is_meta=excluded.is_meta,
        model=excluded.model,
        is_sidechain=excluded.is_sidechain,
        agent_id=excluded.agent_id,
        input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens,
        cwd=excluded.cwd,
        skill=excluded.skill,
        source=excluded.source
    `),
    tc: db.prepare('INSERT OR REPLACE INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path) VALUES (?,?,?,?,?,?)'),
    tr: db.prepare('INSERT OR REPLACE INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path,is_error) VALUES (?,?,?,?,?,?)'),
    idx: db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,?,?)'),
    dur: db.prepare('UPDATE messages SET turn_duration_ms=? WHERE uuid=?'),
    usage: db.prepare('UPDATE messages SET input_tokens=?, output_tokens=? WHERE uuid=?'),
  };

  let currentCwd = projectPath;
  let currentModel = null;
  const eventMessageKeys = new Set();
  const callMessageUuids = new Map();

  for (const { obj } of records) {
    if (obj?.type !== 'event_msg') continue;
    const payload = obj.payload || {};
    if (payload.type !== 'user_message' && payload.type !== 'agent_message') continue;
    const text = codexEventText(payload);
    if (text === null) continue;
    eventMessageKeys.add(codexVisibleMessageKey(payload.type === 'user_message' ? 'user' : 'assistant', text));
  }

  const updateBounds = (ts) => {
    if (!ts) return;
    if (!sm.started_at || ts < sm.started_at) sm.started_at = ts;
    if (!sm.ended_at || ts > sm.ended_at) sm.ended_at = ts;
  };

  const insertMessage = ({ uuid, type, role, text = null, contentType = 'text', timestamp, isMeta = 0 }) => {
    ins.msg.run(
      uuid,
      sessionId,
      type,
      sm.lastMessageUuid,
      timestamp || null,
      role,
      trunc(text),
      contentType,
      isMeta,
      currentModel,
      isSidechain,
      agentId,
      null,
      null,
      currentCwd,
      null,
      'codex',
    );
    sm.lastMessageUuid = uuid;
    if (!agentId) sm.n++;
    if (type === 'assistant' && contentType === 'text') sm.lastTextAssistantUuid = uuid;
    updateBounds(timestamp);
    return uuid;
  };

  for (const { lineNum: currentLine, obj } of records) {
    const ts = obj.timestamp || null;
    if (obj.type === 'session_meta') {
      if (obj.payload?.cwd) {
        currentCwd = normalizeObservedCwd(obj.payload.cwd) || currentCwd;
        if (currentCwd) sm.cwds.push(currentCwd);
      }
      if (obj.payload?.git?.branch) sm.git_branch = obj.payload.git.branch;
      if (obj.payload?.cli_version) sm.version = obj.payload.cli_version;
      updateBounds(obj.payload?.timestamp || ts);
      continue;
    }
    if (obj.type === 'turn_context') {
      currentCwd = normalizeObservedCwd(obj.payload?.cwd) || currentCwd;
      currentModel = obj.payload?.model || currentModel;
      if (currentCwd) sm.cwds.push(currentCwd);
      updateBounds(ts);
      continue;
    }
    if (obj.type === 'event_msg') {
      const payload = obj.payload || {};
      if (payload.type === 'user_message' || payload.type === 'agent_message' || payload.type === 'agent_reasoning') {
        const text = codexEventText(payload);
        if (text === null) continue;
        const isReasoning = payload.type === 'agent_reasoning';
        insertMessage({
          uuid: codexLineUuid(threadRawId, currentLine),
          type: payload.type === 'user_message' ? 'user' : 'assistant',
          role: payload.type === 'user_message' ? 'user' : 'assistant',
          text,
          contentType: isReasoning ? 'thinking' : 'text',
          timestamp: ts,
        });
        continue;
      }
      if (payload.type === 'collab_agent_spawn_end' && payload.call_id && payload.new_thread_id) {
        const uuid = insertMessage({
          uuid: codexLineUuid(threadRawId, currentLine),
          type: 'assistant',
          role: 'assistant',
          text: null,
          contentType: 'tool_use',
          timestamp: ts,
        });
        const toolId = codexCallId(payload.call_id);
        const description = payload.new_agent_nickname || payload.new_agent_role || 'Agent';
        const input = {
          description,
          subagent_type: payload.new_agent_role || 'Agent',
          prompt: payload.prompt || '',
          new_thread_id: payload.new_thread_id,
          model: payload.model || null,
          reasoning_effort: payload.reasoning_effort || null,
        };
        ins.tc.run(toolId, uuid, sessionId, 'Agent', truncJson(input), null);
        callMessageUuids.set(toolId, uuid);
        upsertCodexSubagent(db, {
          agentId: codexDbId(payload.new_thread_id),
          sessionId,
          parentToolUseId: toolId,
          agentType: payload.new_agent_role || null,
          description,
        });
        continue;
      }
      if (payload.type === 'task_complete') {
        if (sm.lastTextAssistantUuid && payload.duration_ms !== undefined) {
          ins.dur.run(payload.duration_ms || null, sm.lastTextAssistantUuid);
        }
        updateBounds(ts);
        continue;
      }
      if (payload.type === 'token_count') {
        const usage = codexUsage(payload);
        if (usage.inputTokens !== null) sm.totalInputTokens = usage.inputTokens;
        if (usage.outputTokens !== null) sm.totalOutputTokens = usage.outputTokens;
        if (sm.lastTextAssistantUuid && (usage.inputTokens !== null || usage.outputTokens !== null)) {
          ins.usage.run(usage.inputTokens, usage.outputTokens, sm.lastTextAssistantUuid);
        }
        continue;
      }
      if (payload.type === 'thread_name_updated' && payload.thread_name) {
        sm.title = payload.thread_name;
      }
      continue;
    }
    if (obj.type !== 'response_item') continue;
    const payload = obj.payload || {};
    if (payload.type === 'message' && payload.role !== 'developer') {
      const text = codexMessagePayloadText(payload);
      const role = payload.role || 'assistant';
      if (text !== null && !eventMessageKeys.has(codexVisibleMessageKey(role, text))) {
        insertMessage({
          uuid: codexLineUuid(threadRawId, currentLine),
          type: role === 'user' ? 'user' : 'assistant',
          role,
          text,
          contentType: 'text',
          timestamp: ts,
        });
      }
      continue;
    }
    if (['function_call', 'custom_tool_call', 'tool_search_call', 'web_search_call'].includes(payload.type) && payload.call_id) {
      const uuid = insertMessage({
        uuid: codexLineUuid(threadRawId, currentLine),
        type: 'assistant',
        role: 'assistant',
        text: null,
        contentType: 'tool_use',
        timestamp: ts,
      });
      const name = payload.name || payload.tool || payload.type.replace(/_call$/, '');
      const toolId = codexCallId(payload.call_id);
      ins.tc.run(toolId, uuid, sessionId, name, truncJson(codexToolInput(payload)), null);
      callMessageUuids.set(toolId, uuid);
      continue;
    }
    if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(payload.type) && payload.call_id) {
      const toolId = codexCallId(payload.call_id);
      ins.tr.run(toolId, callMessageUuids.get(toolId) || null, sessionId, trunc(codexToolOutput(payload) || ''), null, payload.is_error ? 1 : 0);
    }
  }

  if (agentId) {
    const tokenTotal = (sm.totalInputTokens || 0) + (sm.totalOutputTokens || 0);
    const started = sm.started_at ? new Date(sm.started_at).getTime() : null;
    const ended = sm.ended_at ? new Date(sm.ended_at).getTime() : null;
    upsertCodexSubagent(db, {
      agentId,
      sessionId,
      agentType: codexAgentRole(meta),
      description: codexAgentNickname(meta),
      durationMs: started && ended ? ended - started : null,
      totalTokens: tokenTotal || null,
    });
  } else {
    const pp = inferProjectPath(project, sm.cwds);
    ins.ses.run(sessionId, sm.title, project, pp, sm.started_at, sm.ended_at, sm.git_branch, sm.version, sm.n, fi.path, 'codex');
  }
  ins.idx.run(fi.path, mt, lineNum);
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
        indexCodexJsonl(db, f);
      } else {
        indexJsonl(db, f);
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

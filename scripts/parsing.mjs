// Pure parse/discover helpers — node:sqlite-free by construction, so the compiled
// providers can be consumed by the app (better-sqlite3 / a Node without
// node:sqlite). Moved verbatim from db.mjs and indexer.mjs (Phase 5d-1); they use
// only node:fs/path/os. Kept as .mjs (plain ESM) for a low-risk verbatim move.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CODEX_DIR = path.join(os.homedir(), '.codex');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const TEXT_LIMIT = 10000;

// ---- from db.mjs (message/text helpers) ----
function trunc(s) {
  return typeof s === 'string' && s.length > TEXT_LIMIT ? s.slice(0, TEXT_LIMIT) : s;
}

function truncJson(obj, limit = TEXT_LIMIT) {
  if (obj === null || obj === undefined) return null;
  const walk = (v) => {
    if (typeof v === 'string') return v.length > limit ? v.slice(0, limit) + '...[truncated]' : v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(obj));
}

function extractText(content) {
  if (typeof content === 'string') return trunc(content);
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const b of content) {
    if (b.type === 'text' && b.text) parts.push(b.text);
    else if (b.type === 'thinking' && b.thinking) parts.push(b.thinking);
  }
  return parts.length ? trunc(parts.join('\n')) : null;
}

function extractContentType(content) {
  if (typeof content === 'string') return 'text';
  if (!Array.isArray(content) || !content.length) return 'unknown';
  const types = new Set();
  let sawUnknown = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') { sawUnknown = true; continue; }
    if (b.type === 'text') types.add('text');
    else if (b.type === 'thinking') types.add('thinking');
    else if (b.type === 'tool_use') types.add('tool_use');
    else if (b.type === 'tool_result') types.add('tool_result');
    else sawUnknown = true;
  }
  return !sawUnknown && types.size === 1 ? [...types][0] : 'unknown';
}

const COMMAND_ENVELOPE_RE = /^\s*(<command-name>[^<]+<\/command-name>|<(?:task-notification|system-reminder)\b|<local-command(?:\b|-))/;

function extractMessageIsMeta(record, text = extractText(record?.message?.content)) {
  const msg = record?.message || {};
  if (record?.isMeta === true || msg.isMeta === true) return 1;
  return typeof text === 'string' && COMMAND_ENVELOPE_RE.test(text) ? 1 : 0;
}

function filePath(name, input) {
  if (!input) return null;
  return ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name) ? (input.file_path || null) : null;
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function readLines(filePath, callback) {
  const fd = fs.openSync(filePath, 'r');
  const bufSize = 64 * 1024;
  const buf = Buffer.alloc(bufSize);
  let remainder = '';
  let bytesRead;
  try {
    while ((bytesRead = fs.readSync(fd, buf, 0, bufSize)) > 0) {
      const chunk = remainder + buf.toString('utf8', 0, bytesRead);
      const lines = chunk.split('\n');
      remainder = lines.pop();
      for (const line of lines) {
        if (line && callback(line) === false) return;
      }
    }
    if (remainder) callback(remainder);
  } finally {
    fs.closeSync(fd);
  }
}

// ---- from indexer.mjs (project-path + discovery helpers) ----
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

// ---- from indexer.mjs (codex pure helpers) ----
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

export {
  fs, path, os, CLAUDE_DIR, CODEX_DIR, PROJECTS_DIR, CODEX_SESSIONS_DIR, TEXT_LIMIT,
  trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, filePath, isDir, readLines,
  legacyProjectPathFromSlug, normalizeObservedCwd, projectSlugFromPath, inferProjectPath,
  discoverJsonlFiles, discoverCodexJsonlFiles,
  codexDbId, codexRawId, codexLineUuid, codexCallId, codexParentThreadId, codexIsGuardianThread,
  readCodexGuardianThreadInfo, codexAgentNickname, codexAgentRole, parseCodexJsonInput,
  codexUsage, codexEventText, codexMessagePayloadText, codexVisibleMessageKey, codexToolInput, codexToolOutput,
};

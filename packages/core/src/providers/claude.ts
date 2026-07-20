// Claude Code provider adapter in Core (see docs/adr/0001).
//
// Pure: discovers Claude transcript files and parses one into a record stream.
// It never touches the Obelisk database. The per-line logic mirrors the original
// indexJsonl exactly, but yields IndexRecords instead of writing rows; the shared
// persist layer consumes them. Session aggregates here reflect only THIS chunk
// (started_at/ended_at/message_count); persist merges them with any existing row.

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
const require = createRequire(import.meta.url);
const fs = require('node:fs');

import {
  extractText, extractContentType, extractMessageIsMeta,
  filePath, trunc, truncJson, readLines, discoverJsonlFiles,
} from '../parsing.ts';

import type {
  Cursor,
  DiscoverContext,
  IndexRecord,
  IndexUnit,
  ProviderAdapter,
  RawLookup,
  RawRecord,
} from './types.ts';

// Claude cursor encodes the file mtime and the number of lines already indexed:
// "<mtimeMs>:<linesProcessed>". mtime lets discovery detect change; lines lets
// parse resume without reprocessing.
function cursorToSkip(cursor: Cursor): number {
  if (!cursor) return 0;
  const n = Number(cursor.split(':')[1]);
  return Number.isFinite(n) ? n : 0;
}

export const name = 'claude';
export const CLAUDE_INPUT_TOKEN_SEMANTICS_MARKER = '__claude_input_tokens_include_cache_v1__';

function totalInputTokens(usage: Record<string, unknown>): number | null {
  const fields = [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ];
  let seen = false;
  let total = 0;
  for (const field of fields) {
    const value = usage[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

function discoverAt(rootDir: string, ctx: DiscoverContext): IndexUnit[] {
  const projectsDir = join(rootDir, 'projects');
  const changedTranscriptPaths = new Set<string>();
  const forcedPaths = new Set<string>();
  for (const changedPath of ctx.changedPaths ?? []) {
    const absolute = isAbsolute(changedPath)
      ? normalize(changedPath)
      : normalize(join(projectsDir, changedPath));
    const inside = relative(projectsDir, absolute);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
    if (absolute.toLowerCase().endsWith('.meta.json')) {
      const transcript = absolute.slice(0, -'.meta.json'.length) + '.jsonl';
      changedTranscriptPaths.add(transcript);
      forcedPaths.add(transcript);
    } else if (absolute.toLowerCase().endsWith('.jsonl')) {
      changedTranscriptPaths.add(absolute);
    }
  }
  return discoverJsonlFiles(projectsDir).filter((file) => {
    const normalizedPath = normalize(file.path);
    if (ctx.changedPaths !== undefined && !changedTranscriptPaths.has(normalizedPath)) return false;
    const cursor = ctx.lastCursor(file.path);
    return forcedPaths.has(normalizedPath)
      || cursor === null
      || Number(cursor.split(':')[0]) < fs.statSync(file.path).mtimeMs;
  }).map((f: any) => ({
    key: f.path,
    sessionId: f.sessionId,
    project: f.project,
    isSubagent: f.isSubagent,
    agentId: f.agentId,
    meta: f.workflowRunId ? { workflowRunId: f.workflowRunId } : undefined,
  }));
}

export function discover(ctx: DiscoverContext): IndexUnit[] {
  return discoverAt(join(homedir(), '.claude'), ctx);
}

export function* parse(unit: IndexUnit, cursor: Cursor): Generator<IndexRecord, Cursor> {
  const skip = cursorToSkip(cursor);
  const mtime = fs.statSync(unit.key).mtimeMs;
  const isSubagent = unit.isSubagent === true;
  const records: IndexRecord[] = [];
  const sm = {
    started_at: null as string | null,
    ended_at: null as string | null,
    git_branch: null as string | null,
    version: null as string | null,
    title: null as string | null,
    n: 0,
  };
  const subagentStats = {
    startedAt: null as string | null,
    endedAt: null as string | null,
    totalTokens: 0,
  };

  let lineNum = 0;
  readLines(unit.key, (line: string) => {
    lineNum++;
    let obj: any;
    try { obj = JSON.parse(line); } catch { return; }
    const sid = unit.sessionId;
    const ts = obj.timestamp || null;
    const msg = obj.message || {};
    const usage = msg.usage || {};

    if (isSubagent && (obj.type === 'user' || obj.type === 'assistant')) {
      if (ts && (!subagentStats.startedAt || ts < subagentStats.startedAt)) subagentStats.startedAt = ts;
      if (ts && (!subagentStats.endedAt || ts > subagentStats.endedAt)) subagentStats.endedAt = ts;
      subagentStats.totalTokens += (totalInputTokens(usage) ?? 0) + (usage.output_tokens ?? 0);
    }
    if (lineNum <= skip) return;

    if (obj.type === 'ai-title' && obj.aiTitle) { sm.title = obj.aiTitle; return; }
    if (obj.type === 'system' && obj.subtype === 'away_summary' && obj.content) {
      records.push({ kind: 'summary', id: obj.uuid || `${sid}-away-${ts}`, session_id: sid, timestamp: ts, source: 'away_summary', content: obj.content });
      return;
    }
    if (obj.type === 'system' && obj.subtype === 'turn_duration' && obj.parentUuid && obj.durationMs) {
      records.push({ kind: 'message-turn-duration', uuid: obj.parentUuid, turn_duration_ms: obj.durationMs });
      return;
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') return;

    if (ts && (!sm.started_at || ts < sm.started_at)) sm.started_at = ts;
    if (ts && (!sm.ended_at || ts > sm.ended_at)) sm.ended_at = ts;
    if (obj.gitBranch) sm.git_branch = obj.gitBranch;
    if (obj.version) sm.version = obj.version;
    sm.n++;

    const text = extractText(msg.content);
    const contentType = extractContentType(msg.content);
    const isMeta = extractMessageIsMeta(obj, text);
    const aid = isSubagent ? (unit.agentId ?? null) : (obj.agentId || null);

    if (obj.uuid) {
      records.push({
        kind: 'message', uuid: obj.uuid, session_id: sid, type: obj.type,
        parent_uuid: obj.parentUuid || null, timestamp: ts, role: msg.role || obj.type,
        text, content_type: contentType, is_meta: (isMeta ? 1 : 0), model: msg.model || null,
        is_sidechain: obj.isSidechain ? 1 : 0, agent_id: aid,
        input_tokens: totalInputTokens(usage), output_tokens: usage.output_tokens || null,
        cwd: obj.cwd || null, skill: obj.attributionSkill || null, source: 'claude',
      });
    }

    if (obj.type === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use' && b.id)
          records.push({ kind: 'tool_call', id: b.id, message_uuid: obj.uuid, session_id: sid, name: b.name, input_json: truncJson(b.input || {}) as string, file_path: filePath(b.name, b.input) });
      }
    }

    if (obj.type === 'user' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const rt = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((c: any) => c.text || '').join('\n') : '';
        records.push({ kind: 'tool_result', tool_use_id: b.tool_use_id, message_uuid: obj.uuid, session_id: sid, content: trunc(rt), file_path: obj.toolUseResult?.filePath || null, is_error: b.is_error ? 1 : 0 });
      }
    }
  });

  if (isSubagent && unit.agentId) {
    const metaPath = unit.key.replace(/\.jsonl$/, '.meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const workflowRunId = (unit.meta as { workflowRunId?: string } | undefined)?.workflowRunId;
        if (workflowRunId) {
          records.push({
            kind: 'workflow_agent',
            agent_id: unit.agentId,
            run_id: workflowRunId,
            session_id: unit.sessionId,
            agent_type: meta.agentType || null,
            description: meta.description || null,
          });
        } else {
          const started = subagentStats.startedAt ? new Date(subagentStats.startedAt).getTime() : null;
          const ended = subagentStats.endedAt ? new Date(subagentStats.endedAt).getTime() : null;
          records.push({
            kind: 'subagent',
            agent_id: unit.agentId,
            session_id: unit.sessionId,
            parent_tool_use_id: meta.toolUseId || null,
            agent_type: meta.agentType || null,
            description: meta.description || null,
            duration_ms: started !== null && ended !== null ? ended - started : null,
            total_tokens: subagentStats.totalTokens,
          });
        }
      } catch { /* malformed optional subagent metadata */ }
    }
  }

  // Subagent transcripts do not own a session row (matches indexJsonl).
  if (!isSubagent) {
    records.push({
      kind: 'session', id: unit.sessionId, title: sm.title, project: unit.project || null,
      started_at: sm.started_at, ended_at: sm.ended_at, git_branch: sm.git_branch,
      version: sm.version, message_count: sm.n, countMode: skip > 0 ? 'delta' : 'total',
      jsonl_path: unit.key, source: 'claude',
    });
  }

  yield* records;
  return `${mtime}:${lineNum}`;
}

function rawClaude(input: RawLookup): RawRecord | null {
  const mainPath = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
  if (mainPath === null) return null;
  let sourcePath = mainPath;
  if (input.agentId !== null) {
    const runId = input.workflowAgent?.['run_id'];
    sourcePath = typeof runId === 'string'
      ? join(dirname(mainPath), String(input.session?.id ?? ''), 'subagents', 'workflows', runId, `${input.agentId}.jsonl`)
      : join(dirname(mainPath), String(input.session?.id ?? ''), 'subagents', `${input.agentId}.jsonl`);
  }
  if (!fs.existsSync(sourcePath)) return null;
  let found: string | null = null;
  readLines(sourcePath, (line: string) => {
    if (!line.includes(input.messageUuid)) return;
    try {
      if (JSON.parse(line)?.uuid === input.messageUuid) {
        found = line;
        return false;
      }
    } catch { /* malformed source line */ }
  });
  const raw = found as string | null;
  let messageText: string | null = null;
  if (raw !== null) {
    try {
      const content = JSON.parse(raw)?.message?.content;
      if (typeof content === 'string') messageText = content;
      else if (Array.isArray(content)) {
        const parts = content.map((part) => part?.text ?? part?.thinking).filter((part) => typeof part === 'string');
        messageText = parts.length > 0 ? parts.join('\n') : null;
      }
    } catch { /* malformed source line */ }
  }
  return raw === null
    ? null
    : { text: raw, totalLength: raw.length, offset: 0, limit: raw.length, hasMore: false, messageText };
}

export function createClaudeProvider({ rootDir = join(homedir(), '.claude') }: { rootDir?: string } = {}): ProviderAdapter {
  return {
    name,
    descriptor: { id: name, name: 'Claude Code', vendor: 'Anthropic', defaultRoot: rootDir, color: '#d97757' },
    indexVersionMarker: CLAUDE_INPUT_TOKEN_SEMANTICS_MARKER,
    watchRoots: (configuredRoot) => [join(configuredRoot, 'projects')],
    discover: (ctx) => discoverAt(rootDir, ctx),
    parse,
    raw: rawClaude,
  };
}

export const claudeProvider = createClaudeProvider();

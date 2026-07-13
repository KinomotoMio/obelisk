// Claude Code provider adapter in Core (see docs/adr/0001).
//
// Pure: discovers Claude transcript files and parses one into a record stream.
// It never touches the Obelisk database. The per-line logic mirrors the original
// indexJsonl exactly, but yields IndexRecords instead of writing rows; the shared
// persist layer consumes them. Session aggregates here reflect only THIS chunk
// (started_at/ended_at/message_count); persist merges them with any existing row.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');

import {
  extractText, extractContentType, extractMessageIsMeta,
  filePath, trunc, truncJson, readLines, discoverJsonlFiles,
} from '../parsing.ts';

import type { Cursor, DiscoverContext, IndexRecord, IndexUnit, Provider } from './types.ts';

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

export function discover(_ctx: DiscoverContext): IndexUnit[] {
  return discoverJsonlFiles().map((f: any) => ({
    key: f.path,
    sessionId: f.sessionId,
    project: f.project,
    isSubagent: f.isSubagent,
    agentId: f.agentId,
    meta: f.workflowRunId ? { workflowRunId: f.workflowRunId } : undefined,
  }));
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

  let lineNum = 0;
  readLines(unit.key, (line: string) => {
    lineNum++;
    if (lineNum <= skip) return;
    let obj: any;
    try { obj = JSON.parse(line); } catch { return; }
    const sid = unit.sessionId;
    const ts = obj.timestamp || null;

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

    const msg = obj.message || {};
    const text = extractText(msg.content);
    const contentType = extractContentType(msg.content);
    const isMeta = extractMessageIsMeta(obj, text);
    const usage = msg.usage || {};
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

export const claudeProvider: Provider = { name, discover, parse };

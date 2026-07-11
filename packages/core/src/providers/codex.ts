// Codex provider adapter in Core (see docs/adr/0001).
//
// Pure: discovers Codex rollout files and parses one into a record stream. It
// never touches the Obelisk database. Unlike claude, codex is a FULL-REPARSE
// adapter: it buffers every line and re-emits every record on each run, because
// the event_msg ↔ response_item dedup needs whole-file (bidirectional) knowledge
// (the matching pair sits ±1 line apart but in either order). Hence the session
// record uses countMode 'total' (persist replaces the count, never accumulates).
// The per-line logic mirrors the original indexCodexJsonl.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');

import {
  trunc, truncJson, readLines,
  discoverCodexJsonlFiles, normalizeObservedCwd, projectSlugFromPath,
  codexRawId, codexDbId, codexCallId, codexLineUuid, codexParentThreadId,
  codexIsGuardianThread, codexAgentNickname, codexAgentRole, codexUsage,
  codexEventText, codexMessagePayloadText, codexVisibleMessageKey,
  codexToolInput, codexToolOutput,
} from '../parsing.mjs';

import type { Cursor, DiscoverContext, IndexRecord, IndexUnit, MessageRecord, Provider } from './types.ts';

export const name = 'codex';

export function discover(_ctx: DiscoverContext): IndexUnit[] {
  return discoverCodexJsonlFiles().map((f: any) => ({ key: f.path, sessionId: '', meta: { source: 'codex' } }));
}

export function* parse(unit: IndexUnit, _cursor: Cursor): Generator<IndexRecord, Cursor> {
  const mtime = fs.statSync(unit.key).mtimeMs;
  const records: { lineNum: number; obj: any }[] = [];
  let lineNum = 0;
  readLines(unit.key, (line: string) => {
    lineNum++;
    try { records.push({ lineNum, obj: JSON.parse(line) }); } catch { /* skip malformed */ }
  });
  const outCursor = `${mtime}:${lineNum}`;

  const metaRecord = records.find(r => r.obj?.type === 'session_meta' && r.obj.payload?.id);
  if (!metaRecord) return outCursor;

  const meta = metaRecord.obj.payload;
  const threadRawId = codexRawId(meta.id) as string;
  if (codexIsGuardianThread(meta, records)) {
    yield { kind: 'delete-session', sessionId: codexDbId(threadRawId) as string };
    return outCursor;
  }

  const parentRawId = codexParentThreadId(meta);
  const sessionId = codexDbId(parentRawId || threadRawId) as string;
  const agentId = (parentRawId ? codexDbId(threadRawId) : null) as string | null;
  const isSidechain: 0 | 1 = agentId ? 1 : 0;
  const project = projectSlugFromPath(normalizeObservedCwd(meta.cwd));
  const lineUuid = (n: number): string => codexLineUuid(threadRawId, n) as string;

  const out: IndexRecord[] = [];
  const msgByUuid = new Map<string, MessageRecord>();
  const sm = {
    started_at: (meta.timestamp || metaRecord.obj.timestamp || null) as string | null,
    ended_at: (meta.timestamp || metaRecord.obj.timestamp || null) as string | null,
    git_branch: (meta.git?.branch || null) as string | null,
    version: (meta.cli_version || null) as string | null,
    title: null as string | null,
    n: 0,
    lastMessageUuid: null as string | null,
    lastTextAssistantUuid: null as string | null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  let currentCwd = normalizeObservedCwd(meta.cwd);
  let currentModel: string | null = null;
  const eventMessageKeys = new Set<string>();
  const callMessageUuids = new Map<string, string>();

  const updateBounds = (ts: string | null) => {
    if (!ts) return;
    if (!sm.started_at || ts < sm.started_at) sm.started_at = ts;
    if (!sm.ended_at || ts > sm.ended_at) sm.ended_at = ts;
  };

  const insertMessage = ({ uuid, type, role, text = null, contentType = 'text', timestamp, isMeta = 0 }: {
    uuid: string; type: string; role: string; text?: string | null; contentType?: string; timestamp: string | null; isMeta?: 0 | 1;
  }) => {
    const rec: MessageRecord = {
      kind: 'message', uuid, session_id: sessionId, type, parent_uuid: sm.lastMessageUuid,
      timestamp: timestamp || null, role, text: trunc(text), content_type: contentType,
      is_meta: isMeta, model: currentModel, is_sidechain: isSidechain, agent_id: agentId,
      input_tokens: null, output_tokens: null, cwd: currentCwd, skill: null, source: 'codex',
    };
    out.push(rec);
    msgByUuid.set(uuid, rec);
    sm.lastMessageUuid = uuid;
    if (!agentId) sm.n++;
    if (type === 'assistant' && contentType === 'text') sm.lastTextAssistantUuid = uuid;
    updateBounds(timestamp);
    return uuid;
  };

  // First pass: collect visible event_msg keys so duplicate response_items drop.
  for (const { obj } of records) {
    if (obj?.type !== 'event_msg') continue;
    const payload = obj.payload || {};
    if (payload.type !== 'user_message' && payload.type !== 'agent_message') continue;
    const text = codexEventText(payload);
    if (text === null) continue;
    eventMessageKeys.add(codexVisibleMessageKey(payload.type === 'user_message' ? 'user' : 'assistant', text));
  }

  for (const { lineNum: currentLine, obj } of records) {
    const ts = obj.timestamp || null;
    if (obj.type === 'session_meta') {
      if (obj.payload?.cwd) currentCwd = normalizeObservedCwd(obj.payload.cwd) || currentCwd;
      if (obj.payload?.git?.branch) sm.git_branch = obj.payload.git.branch;
      if (obj.payload?.cli_version) sm.version = obj.payload.cli_version;
      updateBounds(obj.payload?.timestamp || ts);
      continue;
    }
    if (obj.type === 'turn_context') {
      currentCwd = normalizeObservedCwd(obj.payload?.cwd) || currentCwd;
      currentModel = obj.payload?.model || currentModel;
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
          uuid: lineUuid(currentLine),
          type: payload.type === 'user_message' ? 'user' : 'assistant',
          role: payload.type === 'user_message' ? 'user' : 'assistant',
          text, contentType: isReasoning ? 'thinking' : 'text', timestamp: ts,
        });
        continue;
      }
      if (payload.type === 'collab_agent_spawn_end' && payload.call_id && payload.new_thread_id) {
        const uuid = insertMessage({ uuid: lineUuid(currentLine), type: 'assistant', role: 'assistant', text: null, contentType: 'tool_use', timestamp: ts });
        const toolId = codexCallId(payload.call_id) as string;
        const description = payload.new_agent_nickname || payload.new_agent_role || 'Agent';
        const input = {
          description, subagent_type: payload.new_agent_role || 'Agent', prompt: payload.prompt || '',
          new_thread_id: payload.new_thread_id, model: payload.model || null, reasoning_effort: payload.reasoning_effort || null,
        };
        out.push({ kind: 'tool_call', id: toolId, message_uuid: uuid, session_id: sessionId, name: 'Agent', input_json: truncJson(input) as string, file_path: null });
        callMessageUuids.set(toolId, uuid);
        out.push({ kind: 'subagent', agent_id: codexDbId(payload.new_thread_id) as string, session_id: sessionId, parent_tool_use_id: toolId, agent_type: payload.new_agent_role || null, description });
        continue;
      }
      if (payload.type === 'task_complete') {
        if (sm.lastTextAssistantUuid && payload.duration_ms !== undefined) {
          out.push({ kind: 'message-turn-duration', uuid: sm.lastTextAssistantUuid, turn_duration_ms: payload.duration_ms || null });
        }
        updateBounds(ts);
        continue;
      }
      if (payload.type === 'token_count') {
        const usage = codexUsage(payload);
        if (usage.inputTokens !== null) sm.totalInputTokens = usage.inputTokens;
        if (usage.outputTokens !== null) sm.totalOutputTokens = usage.outputTokens;
        if (sm.lastTextAssistantUuid && (usage.inputTokens !== null || usage.outputTokens !== null)) {
          const rec = msgByUuid.get(sm.lastTextAssistantUuid);
          if (rec) { rec.input_tokens = usage.inputTokens; rec.output_tokens = usage.outputTokens; }
        }
        continue;
      }
      if (payload.type === 'thread_name_updated' && payload.thread_name) sm.title = payload.thread_name;
      continue;
    }
    if (obj.type !== 'response_item') continue;
    const payload = obj.payload || {};
    if (payload.type === 'message' && payload.role !== 'developer') {
      const text = codexMessagePayloadText(payload);
      const role = payload.role || 'assistant';
      if (text !== null && !eventMessageKeys.has(codexVisibleMessageKey(role, text))) {
        insertMessage({ uuid: lineUuid(currentLine), type: role === 'user' ? 'user' : 'assistant', role, text, contentType: 'text', timestamp: ts });
      }
      continue;
    }
    if (['function_call', 'custom_tool_call', 'tool_search_call', 'web_search_call'].includes(payload.type) && payload.call_id) {
      const uuid = insertMessage({ uuid: lineUuid(currentLine), type: 'assistant', role: 'assistant', text: null, contentType: 'tool_use', timestamp: ts });
      const name = payload.name || payload.tool || payload.type.replace(/_call$/, '');
      const toolId = codexCallId(payload.call_id) as string;
      out.push({ kind: 'tool_call', id: toolId, message_uuid: uuid, session_id: sessionId, name, input_json: truncJson(codexToolInput(payload)) as string, file_path: null });
      callMessageUuids.set(toolId, uuid);
      continue;
    }
    if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(payload.type) && payload.call_id) {
      const toolId = codexCallId(payload.call_id) as string;
      out.push({ kind: 'tool_result', tool_use_id: toolId, message_uuid: callMessageUuids.get(toolId) || '', session_id: sessionId, content: trunc(codexToolOutput(payload) || ''), file_path: null, is_error: payload.is_error ? 1 : 0 });
    }
  }

  if (agentId) {
    const started = sm.started_at ? new Date(sm.started_at).getTime() : null;
    const ended = sm.ended_at ? new Date(sm.ended_at).getTime() : null;
    const tokenTotal = (sm.totalInputTokens || 0) + (sm.totalOutputTokens || 0);
    out.push({
      kind: 'subagent', agent_id: agentId, session_id: sessionId,
      agent_type: codexAgentRole(meta), description: codexAgentNickname(meta),
      duration_ms: started && ended ? ended - started : null, total_tokens: tokenTotal || null,
    });
  } else {
    out.push({
      kind: 'session', id: sessionId, title: sm.title, project,
      started_at: sm.started_at, ended_at: sm.ended_at, git_branch: sm.git_branch, version: sm.version,
      message_count: sm.n, countMode: 'total', jsonl_path: unit.key, source: 'codex',
    });
  }

  yield* out;
  return outCursor;
}

export const codexProvider: Provider = { name, discover, parse };

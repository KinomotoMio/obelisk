// Data loading layer -- bridges Electron IPC (window.obelisk.*) to reactive store.
// All DB access goes through this module.

import { markRaw } from 'vue';
import { state } from './store.js';

/**
 * Load initial data from the DB and populate state.memories, state.sessions,
 * and state.projects.
 */
export async function loadInitialData() {
  const [rawMemories, rawSessions, stats, projects] = await Promise.all([
    window.obelisk.getMemories(),
    window.obelisk.getSessions({ source: 'all', limit: 1000 }),
    window.obelisk.getStats(),
    window.obelisk.getProjects()
  ]);

  // Transform memories: DB records -> render-layer shape
  state.memories = (rawMemories || []).map(m => ({
    ...m,
    ts: m.created_at ? new Date(m.created_at).getTime() : 0,
    archived: !!m.deleted_at,
    archivedAt: m.deleted_at ? new Date(m.deleted_at).getTime() : null,
    anchors: m.anchors ? (typeof m.anchors === 'string' ? JSON.parse(m.anchors) : m.anchors) : [],
    markdown: null  // loaded on demand via loadMemoryMarkdown
  }));

  // Sessions: merge with existing data to preserve already-loaded messages
  const existingSessions = new Map(state.sessions.map(s => [s.id, s]));
  state.sessions = (rawSessions || []).map(s => {
    const existing = existingSessions.get(s.id);
    return {
      ...s,
      messages: existing?.messages?.length ? existing.messages : []
    };
  });

  state.projects = projects || [];
  state.stats = stats || {};
  state.loaded = true;
}

/**
 * Load full detail for a session: messages with inline tool_calls (each with
 * result), summaries, subagents, and workflow data.
 *
 * Returns the assembled session object (also updates state.sessions entry).
 */
export async function loadSessionDetail(sessionId) {
  const [messages, toolCalls, toolResults, subagents, workflows, summaries] =
    await Promise.all([
      window.obelisk.getSessionMessages(sessionId),
      window.obelisk.getSessionToolCalls(sessionId),
      window.obelisk.getSessionToolResults(sessionId),
      window.obelisk.getSessionSubagents(sessionId),
      window.obelisk.getSessionWorkflows(sessionId),
      window.obelisk.getSessionSummaries(sessionId)
    ]);

  // Index tool results by tool_use_id for fast lookup
  const resultsByCallId = {};
  for (const r of (toolResults || [])) {
    resultsByCallId[r.tool_use_id] = r;
  }

  // Index subagents by parent_tool_use_id
  const subagentsByCallId = {};
  for (const sa of (subagents || [])) {
    if (sa.parent_tool_use_id) {
      subagentsByCallId[sa.parent_tool_use_id] = sa;
    }
  }

  // Group tool_calls by message_uuid, attaching result and subagent inline
  const callsByMessageUuid = {};
  for (const tc of (toolCalls || [])) {
    const call = {
      id: tc.id,
      name: tc.name,
      input_json: tc.input_json,
      result: resultsByCallId[tc.id] || null
    };

    // Attach subagent data if present
    const sa = subagentsByCallId[tc.id];
    if (sa) {
      call.subagent = {
        agent_id: sa.agent_id,
        agent_type: sa.agent_type,
        description: sa.description
      };
    }

    const msgUuid = tc.message_uuid;
    if (!callsByMessageUuid[msgUuid]) callsByMessageUuid[msgUuid] = [];
    callsByMessageUuid[msgUuid].push(call);
  }

  // Attach workflow data to Workflow tool calls
  for (const wf of (workflows || [])) {
    for (const calls of Object.values(callsByMessageUuid)) {
      for (const call of calls) {
        if (call.name === 'Workflow' && !call.workflow) {
          const resultText = call.result?.content || '';
          if (resultText.includes(wf.run_id) || resultText.includes(wf.workflow_name || '___none___')) {
            call.workflow = {
              run_id: wf.run_id,
              workflow_name: wf.workflow_name,
              status: wf.status,
              duration_ms: wf.duration_ms,
              total_tokens: wf.total_tokens,
              agent_count: wf.agent_count,
              agents: (wf.agents || []).map(a => ({
                agent_id: a.agent_id,
                phase: a.phase,
                label: a.label,
                state: a.state,
                tokens: a.tokens,
                duration_ms: a.duration_ms,
              }))
            };
          }
        }
      }
    }
  }

  // Index summaries by session
  const sessionSummaries = (summaries || []).map(s => ({
    source: s.source,
    content: s.content,
    timestamp: s.timestamp
  }));

  // Assemble messages with tool_calls inline
  const META_RE = /^\s*<(task-notification|command-name|local-command|system-reminder)/;
  const rawAssembled = (messages || []).map(msg => {
    const assembled = {
      uuid: msg.uuid,
      type: msg.type || msg.role,
      timestamp: msg.timestamp,
      text: msg.text,
      content_type: msg.content_type || null,
      is_meta: msg.is_meta || (msg.text && META_RE.test(msg.text) ? 1 : 0)
    };

    const calls = callsByMessageUuid[msg.uuid];
    if (calls && calls.length > 0) {
      assembled.tool_calls = calls;
    }

    return assembled;
  });

  // Merge adjacent assistant messages:
  // - tool_result user messages are skipped (results shown inside tool_call panels)
  // - consecutive tool_use messages (separated by tool_results) merge into one
  // - thinking messages merge into the next non-thinking assistant message
  const assembledMessages = [];
  for (let i = 0; i < rawAssembled.length; i++) {
    const msg = rawAssembled[i];

    // Skip tool_result user messages
    if (msg.content_type === 'tool_result') continue;

    // For thinking messages, collect consecutive thinking blocks and attach to the next assistant
    if (msg.type === 'assistant' && msg.content_type === 'thinking') {
      const thinkingParts = [msg.text || ''];
      let j = i + 1;
      while (j < rawAssembled.length && rawAssembled[j].type === 'assistant' && rawAssembled[j].content_type === 'thinking') {
        thinkingParts.push(rawAssembled[j].text || '');
        j++;
      }
      if (j < rawAssembled.length && rawAssembled[j].type === 'assistant' && rawAssembled[j].content_type !== 'thinking') {
        rawAssembled[j]._thinking = thinkingParts.join('\n\n');
        i = j - 1;
        continue;
      }
      assembledMessages.push({ ...msg, text: thinkingParts.join('\n\n'), content_type: 'thinking' });
      i = j - 1;
      continue;
    }

    // For tool_use assistant messages, absorb subsequent tool_use (skipping tool_results and skill meta)
    if (msg.type === 'assistant' && msg.content_type === 'tool_use') {
      const merged = { ...msg, tool_calls: [...(msg.tool_calls || [])] };
      if (msg._thinking) merged._thinking = msg._thinking;

      // If this is a Skill-only message, don't merge with subsequent tool_use — keep it standalone
      const isSkillOnly = merged.tool_calls.length === 1 && merged.tool_calls[0].name === 'Skill';

      let j = i + 1;
      while (j < rawAssembled.length) {
        const next = rawAssembled[j];
        if (next.content_type === 'tool_result') { j++; continue; }
        // Absorb skill.md meta message into the skill tool call
        if (next.is_meta && next.text && next.text.includes('Base directory for this skill')) {
          merged._skillMd = next.text;
          j++;
          continue;
        }
        if (!isSkillOnly && next.type === 'assistant' && next.content_type === 'tool_use') {
          if (next.tool_calls) merged.tool_calls.push(...next.tool_calls);
          if (next.text && !merged.text) merged.text = next.text;
          j++;
          continue;
        }
        break;
      }
      assembledMessages.push(merged);
      i = j - 1;
    } else {
      const out = { ...msg };
      if (msg._thinking) out._thinking = msg._thinking;
      // For text assistant messages, absorb following tool_use messages (Codex pattern)
      if (msg.type === 'assistant' && msg.content_type !== 'tool_use' && msg.content_type !== 'thinking') {
        if (!out.tool_calls) out.tool_calls = [];
        let j = i + 1;
        while (j < rawAssembled.length) {
          const next = rawAssembled[j];
          if (next.content_type === 'tool_result') { j++; continue; }
          if (next.type === 'assistant' && next.content_type === 'tool_use') {
            if (next.tool_calls) out.tool_calls.push(...next.tool_calls);
            j++;
            continue;
          }
          break;
        }
        if (!out.tool_calls.length) delete out.tool_calls;
        i = j - 1;
      }
      assembledMessages.push(out);
    }
  }

  // Attach workflow data if present
  const workflow = (workflows && workflows.length > 0) ? workflows[0] : null;

  // Build assembled session object
  const session = state.sessions.find(s => s.id === sessionId);
  const assembled = {
    ...(session || {}),
    id: sessionId,
    messages: assembledMessages
  };

  if (workflow) {
    assembled.workflow = workflow;
  }

  // Update in-place in state.sessions
  const idx = state.sessions.findIndex(s => s.id === sessionId);
  if (idx !== -1) {
    state.sessions[idx] = assembled;
  }

  return assembled;
}

/**
 * Load full detail for a subagent conversation.
 * Returns assembled messages with tool_calls inline.
 */
export async function loadSubagentDetail(agentId) {
  const [messages, toolCalls, toolResults] = await Promise.all([
    window.obelisk.getSubagentMessages(agentId),
    window.obelisk.getSubagentToolCalls(agentId),
    window.obelisk.getSubagentToolResults(agentId),
  ]);

  const resultsByCallId = {};
  for (const r of (toolResults || [])) {
    resultsByCallId[r.tool_use_id] = r;
  }

  const callsByMessageUuid = {};
  for (const tc of (toolCalls || [])) {
    const call = {
      id: tc.id,
      name: tc.name,
      input_json: tc.input_json,
      result: resultsByCallId[tc.id] || null
    };
    const msgUuid = tc.message_uuid;
    if (!callsByMessageUuid[msgUuid]) callsByMessageUuid[msgUuid] = [];
    callsByMessageUuid[msgUuid].push(call);
  }

  const rawAssembled = (messages || []).map(msg => {
    const assembled = {
      uuid: msg.uuid,
      type: msg.type || msg.role,
      timestamp: msg.timestamp,
      text: msg.text,
      content_type: msg.content_type || null,
      is_meta: msg.is_meta || 0
    };
    const calls = callsByMessageUuid[msg.uuid];
    if (calls && calls.length > 0) assembled.tool_calls = calls;
    return assembled;
  });

  // Same merging logic as session detail
  const assembledMessages = [];
  for (let i = 0; i < rawAssembled.length; i++) {
    const msg = rawAssembled[i];
    if (msg.content_type === 'tool_result') continue;
    if (msg.type === 'assistant' && msg.content_type === 'thinking') {
      const thinkingParts = [msg.text || ''];
      let j = i + 1;
      while (j < rawAssembled.length && rawAssembled[j].type === 'assistant' && rawAssembled[j].content_type === 'thinking') {
        thinkingParts.push(rawAssembled[j].text || '');
        j++;
      }
      if (j < rawAssembled.length && rawAssembled[j].type === 'assistant' && rawAssembled[j].content_type !== 'thinking') {
        rawAssembled[j]._thinking = thinkingParts.join('\n\n');
        i = j - 1;
        continue;
      }
      assembledMessages.push({ ...msg, text: thinkingParts.join('\n\n'), content_type: 'thinking' });
      i = j - 1;
      continue;
    }
    if (msg.type === 'assistant' && msg.content_type === 'tool_use') {
      const merged = { ...msg, tool_calls: [...(msg.tool_calls || [])] };
      if (msg._thinking) merged._thinking = msg._thinking;
      let j = i + 1;
      while (j < rawAssembled.length) {
        const next = rawAssembled[j];
        if (next.content_type === 'tool_result') { j++; continue; }
        if (next.type === 'assistant' && next.content_type === 'tool_use') {
          if (next.tool_calls) merged.tool_calls.push(...next.tool_calls);
          if (next.text && !merged.text) merged.text = next.text;
          j++;
          continue;
        }
        break;
      }
      assembledMessages.push(merged);
      i = j - 1;
    } else {
      const out = { ...msg };
      if (msg._thinking) out._thinking = msg._thinking;
      assembledMessages.push(out);
    }
  }

  return assembledMessages;
}

const TEXT_LIMIT = 10000;

/**
 * Check if a message text was truncated during indexing.
 */
export function isTextTruncated(text) {
  return text && text.length >= TEXT_LIMIT;
}

/**
 * Fetch the full untruncated text for a message from its source JSONL.
 * Returns the full text string or null.
 */
export async function loadFullText(uuid) {
  try {
    return await window.obelisk.getMessageFullText(uuid);
  } catch {
    return null;
  }
}

/**
 * Load the markdown content of a memory file.
 * Returns the content string or null on failure.
 */
export async function loadMemoryMarkdown(memoryPath) {
  try {
    const content = await window.obelisk.readMemoryFile(memoryPath);
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Archive a memory by id. Updates state after successful IPC call.
 */
export async function archiveMemory(id) {
  await window.obelisk.archiveMemory(id);
  const mem = state.memories.find(m => m.id === id);
  if (mem) {
    mem.archived = true;
    mem.archivedAt = Date.now();
  }
}

/**
 * Restore an archived memory by id. Updates state after successful IPC call.
 */
export async function restoreMemory(id) {
  await window.obelisk.restoreMemory(id);
  const mem = state.memories.find(m => m.id === id);
  if (mem) {
    mem.archived = false;
    mem.archivedAt = null;
  }
}

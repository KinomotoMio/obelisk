// @ts-check

/** @typedef {import('./session-detail-types.ts').AssembledMessage} AssembledMessage */
/** @typedef {import('./session-detail-types.ts').AssembledToolCall} AssembledToolCall */
/** @typedef {import('./session-detail-types.ts').SessionDetailAssemblyInput} SessionDetailAssemblyInput */
/** @typedef {import('./session-detail-types.ts').SessionSubagentRow} SessionSubagentRow */
/** @typedef {import('./session-detail-types.ts').SessionToolResultRow} SessionToolResultRow */

/**
 * @param {SessionDetailAssemblyInput} input
 * @returns {AssembledMessage[]}
 */
export function assembleSessionMessages({ messages, toolCalls, toolResults, subagents, workflows }) {
  const resultsByCallId = /** @type {Map<string, SessionToolResultRow>} */ (new Map());
  for (const result of toolResults || []) resultsByCallId.set(result.tool_use_id, result);

  const subagentsByCallId = /** @type {Map<string, SessionSubagentRow>} */ (new Map());
  for (const subagent of subagents || []) {
    if (subagent.parent_tool_use_id) subagentsByCallId.set(subagent.parent_tool_use_id, subagent);
  }

  const callsByMessageUuid = /** @type {Map<string, AssembledToolCall[]>} */ (new Map());
  for (const toolCall of toolCalls || []) {
    const call = /** @type {AssembledToolCall} */ ({
      id: toolCall.id,
      name: toolCall.name,
      input_json: toolCall.input_json,
      result: resultsByCallId.get(toolCall.id) || null,
    });
    const subagent = subagentsByCallId.get(toolCall.id);
    if (subagent) {
      call.subagent = {
        agent_id: subagent.agent_id,
        agent_type: subagent.agent_type,
        description: subagent.description,
      };
    }
    const messageUuid = toolCall.message_uuid;
    const calls = callsByMessageUuid.get(messageUuid) || [];
    calls.push(call);
    callsByMessageUuid.set(messageUuid, calls);
  }

  for (const workflow of workflows || []) {
    for (const calls of callsByMessageUuid.values()) {
      for (const call of calls) {
        if (call.name !== 'Workflow' || call.workflow) continue;
        const resultText = call.result?.content || '';
        if (!resultText.includes(workflow.run_id) && !resultText.includes(workflow.workflow_name || '___none___')) continue;
        call.workflow = {
          run_id: workflow.run_id,
          workflow_name: workflow.workflow_name,
          status: workflow.status,
          duration_ms: workflow.duration_ms,
          total_tokens: workflow.total_tokens,
          agent_count: workflow.agent_count,
          agents: (workflow.agents || []).map(agent => ({
            agent_id: agent.agent_id,
            phase: agent.phase,
            label: agent.label,
            state: agent.state,
            tokens: agent.tokens,
            duration_ms: agent.duration_ms,
          })),
        };
      }
    }
  }

  const metaPattern = /^\s*<(task-notification|command-name|local-command|system-reminder)/;
  const rawAssembled = (messages || []).map(message => {
    const assembled = /** @type {AssembledMessage} */ ({
      uuid: message.uuid,
      type: message.type || message.role,
      timestamp: message.timestamp,
      text: message.text,
      content_type: message.content_type || null,
      is_meta: message.is_meta || (message.text && metaPattern.test(message.text) ? 1 : 0),
    });
    const calls = callsByMessageUuid.get(message.uuid);
    if (calls?.length) assembled.tool_calls = calls;
    return assembled;
  });

  const assembledMessages = /** @type {AssembledMessage[]} */ ([]);
  for (let index = 0; index < rawAssembled.length; index++) {
    const message = rawAssembled[index];
    if (message.content_type === 'tool_result') continue;

    if (message.type === 'assistant' && message.content_type === 'thinking') {
      const thinkingParts = [message.text || ''];
      let nextIndex = index + 1;
      while (
        nextIndex < rawAssembled.length
        && rawAssembled[nextIndex].type === 'assistant'
        && rawAssembled[nextIndex].content_type === 'thinking'
      ) {
        thinkingParts.push(rawAssembled[nextIndex].text || '');
        nextIndex++;
      }
      if (
        nextIndex < rawAssembled.length
        && rawAssembled[nextIndex].type === 'assistant'
        && rawAssembled[nextIndex].content_type !== 'thinking'
      ) {
        rawAssembled[nextIndex]._thinking = thinkingParts.join('\n\n');
        index = nextIndex - 1;
        continue;
      }
      assembledMessages.push({ ...message, text: thinkingParts.join('\n\n'), content_type: 'thinking' });
      index = nextIndex - 1;
      continue;
    }

    if (message.type === 'assistant' && message.content_type === 'tool_use') {
      const merged = /** @type {AssembledMessage} */ ({
        ...message,
        tool_calls: [...(message.tool_calls || [])],
      });
      const mergedCalls = merged.tool_calls || [];
      if (message._thinking) merged._thinking = message._thinking;
      const skillOnly = mergedCalls.length === 1 && mergedCalls[0].name === 'Skill';
      let nextIndex = index + 1;
      while (nextIndex < rawAssembled.length) {
        const next = rawAssembled[nextIndex];
        if (next.content_type === 'tool_result') {
          nextIndex++;
          continue;
        }
        if (next.is_meta && next.text && next.text.includes('Base directory for this skill')) {
          merged._skillMd = next.text;
          nextIndex++;
          continue;
        }
        if (!skillOnly && next.type === 'assistant' && next.content_type === 'tool_use') {
          if (next.tool_calls) mergedCalls.push(...next.tool_calls);
          if (next.text && !merged.text) merged.text = next.text;
          nextIndex++;
          continue;
        }
        break;
      }
      assembledMessages.push(merged);
      index = nextIndex - 1;
      continue;
    }

    const output = /** @type {AssembledMessage} */ ({ ...message });
    if (message._thinking) output._thinking = message._thinking;
    if (message.type === 'assistant' && message.content_type !== 'tool_use' && message.content_type !== 'thinking') {
      if (!output.tool_calls) output.tool_calls = [];
      let nextIndex = index + 1;
      while (nextIndex < rawAssembled.length) {
        const next = rawAssembled[nextIndex];
        if (next.content_type === 'tool_result') {
          nextIndex++;
          continue;
        }
        if (next.type === 'assistant' && next.content_type === 'tool_use') {
          if (next.tool_calls) output.tool_calls.push(...next.tool_calls);
          nextIndex++;
          continue;
        }
        break;
      }
      if (!output.tool_calls.length) delete output.tool_calls;
      index = nextIndex - 1;
    }
    assembledMessages.push(output);
  }

  return assembledMessages;
}

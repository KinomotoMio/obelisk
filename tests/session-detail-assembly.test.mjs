import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleSessionMessages } from '../app/src/shared/session-detail-assembly.mjs';

test('session assembly preserves thinking and attaches tool result and subagent evidence', () => {
  const messages = [
    { uuid: 'thinking-1', type: 'assistant', content_type: 'thinking', text: 'reasoning' },
    { uuid: 'answer-1', type: 'assistant', content_type: 'text', text: 'answer' },
    { uuid: 'tool-1', type: 'assistant', content_type: 'tool_use', text: '' },
    { uuid: 'result-1', type: 'user', content_type: 'tool_result', text: '' },
  ];
  const assembled = assembleSessionMessages({
    messages,
    toolCalls: [{ id: 'call-1', message_uuid: 'tool-1', name: 'Agent', input_json: '{"description":"inspect"}' }],
    toolResults: [{ tool_use_id: 'call-1', message_uuid: 'result-1', content: 'done', is_error: 0 }],
    subagents: [{ agent_id: 'agent-1', parent_tool_use_id: 'call-1', agent_type: 'reviewer', description: 'inspect' }],
    workflows: [],
  });

  assert.equal(assembled.length, 1);
  assert.equal(assembled[0].uuid, 'answer-1');
  assert.equal(assembled[0]._thinking, 'reasoning');
  assert.deepEqual(assembled[0].tool_calls[0].result.content, 'done');
  assert.equal(assembled[0].tool_calls[0].subagent.agent_id, 'agent-1');
});

test('session assembly keeps Skill evidence standalone and embeds matching workflow agents', () => {
  const assembled = assembleSessionMessages({
    messages: [
      { uuid: 'skill-1', type: 'assistant', content_type: 'tool_use', text: '' },
      { uuid: 'skill-md', type: 'user', content_type: 'text', is_meta: 1, text: 'Base directory for this skill\n# Skill' },
      { uuid: 'workflow-1', type: 'assistant', content_type: 'tool_use', text: '' },
    ],
    toolCalls: [
      { id: 'call-skill', message_uuid: 'skill-1', name: 'Skill', input_json: '{"skill":"obelisk"}' },
      { id: 'call-workflow', message_uuid: 'workflow-1', name: 'Workflow', input_json: '{}' },
    ],
    toolResults: [{ tool_use_id: 'call-workflow', content: 'run-1 complete', is_error: 0 }],
    subagents: [],
    workflows: [{
      run_id: 'run-1',
      workflow_name: 'review',
      status: 'complete',
      agents: [{ agent_id: 'agent-1', phase: 'review', label: 'Reviewer', state: 'complete' }],
    }],
  });

  assert.equal(assembled[0]._skillMd, 'Base directory for this skill\n# Skill');
  assert.equal(assembled[1].tool_calls[0].workflow.run_id, 'run-1');
  assert.deepEqual(assembled[1].tool_calls[0].workflow.agents, [{
    agent_id: 'agent-1',
    phase: 'review',
    label: 'Reviewer',
    state: 'complete',
    tokens: undefined,
    duration_ms: undefined,
  }]);
});

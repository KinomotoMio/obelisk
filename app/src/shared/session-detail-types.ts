export interface SessionMessageRow {
  [key: string]: unknown;
  uuid: string;
  type?: string | null;
  role?: string | null;
  timestamp?: string | null;
  text?: string | null;
  content_type?: string | null;
  is_meta?: number | boolean | null;
}

export interface SessionToolResultRow {
  [key: string]: unknown;
  tool_use_id: string;
  content?: string | null;
}

export interface SessionToolCallRow {
  [key: string]: unknown;
  id: string;
  message_uuid: string;
  name: string;
  input_json?: string | null;
}

export interface SessionSubagentRow {
  [key: string]: unknown;
  agent_id: string;
  parent_tool_use_id?: string | null;
  agent_type?: string | null;
  description?: string | null;
}

export interface SessionWorkflowAgentRow {
  [key: string]: unknown;
  agent_id: string;
  phase?: string | null;
  label?: string | null;
  state?: string | null;
  tokens?: number | null;
  duration_ms?: number | null;
}

export interface SessionWorkflowRow {
  [key: string]: unknown;
  run_id: string;
  workflow_name?: string | null;
  status?: string | null;
  duration_ms?: number | null;
  total_tokens?: number | null;
  agent_count?: number | null;
  agents?: SessionWorkflowAgentRow[] | null;
}

export interface SessionSummaryRow {
  [key: string]: unknown;
  id: string | number;
}

export interface SessionDetailAssemblyInput {
  messages?: SessionMessageRow[];
  toolCalls?: SessionToolCallRow[];
  toolResults?: SessionToolResultRow[];
  subagents?: SessionSubagentRow[];
  workflows?: SessionWorkflowRow[];
  summaries?: SessionSummaryRow[];
}

export interface AssembledToolCall {
  [key: string]: unknown;
  id: string;
  name: string;
  input_json?: string | null;
  result: SessionToolResultRow | null;
  subagent?: {
    agent_id: string;
    agent_type?: string | null;
    description?: string | null;
  };
  workflow?: {
    run_id: string;
    workflow_name?: string | null;
    status?: string | null;
    duration_ms?: number | null;
    total_tokens?: number | null;
    agent_count?: number | null;
    agents: Array<{
      agent_id: string;
      phase?: string | null;
      label?: string | null;
      state?: string | null;
      tokens?: number | null;
      duration_ms?: number | null;
    }>;
  };
}

export interface AssembledMessage extends SessionMessageRow {
  type?: string | null;
  content_type?: string | null;
  is_meta?: number | boolean | null;
  tool_calls?: AssembledToolCall[];
  _thinking?: string;
  _skillMd?: string;
}

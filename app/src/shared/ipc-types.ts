export interface SourceQueryOptions {
  source?: string;
}

export type UsageStatsOptions = SourceQueryOptions;

export type SessionPatchTable =
  | 'messages'
  | 'toolCalls'
  | 'toolResults'
  | 'subagents'
  | 'workflows'
  | 'summaries';

export type SessionPatchRow = Record<string, unknown>;
export type SessionPatchSnapshot = Partial<Record<SessionPatchTable, SessionPatchRow[]>>;
export type SessionPatchCursor = Record<SessionPatchTable, Record<string, string>>;

export interface SessionPatch {
  changes: Record<SessionPatchTable, SessionPatchRow[]>;
  removed: Record<SessionPatchTable, string[]>;
  hashes: Record<SessionPatchTable, Record<string, string>>;
  positions: Record<SessionPatchTable, Record<string, number>>;
}

export interface AppliedSessionPatch {
  snapshot: Record<SessionPatchTable, SessionPatchRow[]>;
  cursor: SessionPatchCursor;
}

// Shared persist layer (see docs/adr/0001).
//
// Provider-agnostic and binding-agnostic: it consumes the IndexRecord stream
// from any adapter's parse() and writes rows into the injected database handle
// (node:sqlite for the skill/CLI, better-sqlite3 for the app — they share the
// prepare/run/get API). It is the ONLY layer that touches the database and the
// only place that knows the schema. Adapters stay pure.
//
// Write semantics are the canonical ones reconciled from the drift: messages
// upsert via ON CONFLICT; sessions merge with any existing row (started_at MIN,
// ended_at MAX, message_count reset-or-accumulate, fill-if-null for the rest);
// turn-duration is a targeted UPDATE; delete-session cascades. The generator's
// return value is the new cursor, persisted verbatim into index_state.

import type { Cursor, IndexRecord, IndexUnit } from './providers/types.ts';

const minStr = (a: string | null, b: string | null) => (a == null ? b : b == null ? a : a < b ? a : b);
const maxStr = (a: string | null, b: string | null) => (a == null ? b : b == null ? a : a > b ? a : b);

function statements(db: any) {
  return {
    msg: db.prepare(`
      INSERT INTO messages (uuid,session_id,type,parent_uuid,timestamp,role,text,content_type,is_meta,model,is_sidechain,agent_id,input_tokens,output_tokens,cwd,skill,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(uuid) DO UPDATE SET
        session_id=excluded.session_id, type=excluded.type, parent_uuid=excluded.parent_uuid,
        timestamp=excluded.timestamp, role=excluded.role, text=excluded.text,
        content_type=excluded.content_type, is_meta=excluded.is_meta, model=excluded.model,
        is_sidechain=excluded.is_sidechain, agent_id=excluded.agent_id,
        input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
        cwd=excluded.cwd, skill=excluded.skill, source=excluded.source`),
    tc: db.prepare('INSERT OR REPLACE INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path) VALUES (?,?,?,?,?,?)'),
    tr: db.prepare('INSERT OR REPLACE INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path,is_error) VALUES (?,?,?,?,?,?)'),
    sum: db.prepare('INSERT OR REPLACE INTO summaries (id,session_id,timestamp,source,content) VALUES (?,?,?,?,?)'),
    ses: db.prepare('INSERT OR REPLACE INTO sessions (id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    turn: db.prepare('UPDATE messages SET turn_duration_ms=? WHERE uuid=?'),
    idx: db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,?,?)'),
    getSession: db.prepare('SELECT * FROM sessions WHERE id=?'),
    getState: db.prepare('SELECT lines_processed FROM index_state WHERE jsonl_path=?'),
  };
}

// Cascade-delete every row belonging to a session/thread (guardian retraction).
function deleteSession(db: any, sessionId: string) {
  db.prepare('DELETE FROM tool_results WHERE session_id=? OR message_uuid IN (SELECT uuid FROM messages WHERE session_id=? OR agent_id=?)').run(sessionId, sessionId, sessionId);
  db.prepare('DELETE FROM tool_calls WHERE session_id=? OR message_uuid IN (SELECT uuid FROM messages WHERE session_id=? OR agent_id=?)').run(sessionId, sessionId, sessionId);
  db.prepare('DELETE FROM messages WHERE session_id=? OR agent_id=?').run(sessionId, sessionId);
  db.prepare('DELETE FROM subagents WHERE agent_id=? OR session_id=?').run(sessionId, sessionId);
  db.prepare('DELETE FROM summaries WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
}

// Consume one unit's record stream into the database and return the new cursor
// (also written to index_state). `db` is any SQLite handle sharing prepare/run.
export function persist(db: any, unit: IndexUnit, gen: Generator<IndexRecord, Cursor>): Cursor {
  const st = statements(db);
  // A prior lines_processed>0 means this parse resumed, so message_count must
  // accumulate onto the existing row rather than reset (matches indexJsonl).
  const resuming = ((st.getState.get(unit.key)?.lines_processed as number) || 0) > 0;

  const write = (r: IndexRecord) => {
    switch (r.kind) {
      case 'message':
        st.msg.run(r.uuid, r.session_id, r.type, r.parent_uuid, r.timestamp, r.role, r.text, r.content_type, r.is_meta, r.model, r.is_sidechain, r.agent_id, r.input_tokens, r.output_tokens, r.cwd, r.skill, r.source);
        break;
      case 'tool_call':
        st.tc.run(r.id, r.message_uuid, r.session_id, r.name, r.input_json, r.file_path);
        break;
      case 'tool_result':
        st.tr.run(r.tool_use_id, r.message_uuid, r.session_id, r.content, r.file_path, r.is_error);
        break;
      case 'summary':
        st.sum.run(r.id, r.session_id, r.timestamp, r.source, r.content);
        break;
      case 'message-turn-duration':
        st.turn.run(r.turn_duration_ms, r.uuid);
        break;
      case 'session': {
        const prev = st.getSession.get(r.id);
        st.ses.run(
          r.id,
          r.title ?? prev?.title ?? null,
          r.project ?? prev?.project ?? null,
          prev?.project_path ?? null, // authoritative project_path is set by refreshSessionProjectPaths
          minStr(prev?.started_at ?? null, r.started_at),
          maxStr(prev?.ended_at ?? null, r.ended_at),
          r.git_branch ?? prev?.git_branch ?? null,
          r.version ?? prev?.version ?? null,
          resuming ? (prev?.message_count || 0) + r.message_count : r.message_count,
          r.jsonl_path,
          r.source,
        );
        break;
      }
      case 'delete-session':
        deleteSession(db, r.sessionId);
        break;
      default:
        throw new Error(`persist: unhandled record kind ${(r as { kind: string }).kind}`);
    }
  };

  let step = gen.next();
  while (!step.done) { write(step.value); step = gen.next(); }
  const cursor = step.value;

  if (cursor != null) {
    const [mtime, lines] = cursor.split(':');
    st.idx.run(unit.key, Number(mtime), Number(lines));
  }
  return cursor;
}

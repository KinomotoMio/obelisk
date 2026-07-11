// Obelisk Core package (see docs/adr/0003-core-typescript-esm-precompiled.md).
//
// The single shared implementation behind every transport. runtime.mjs (skill),
// and later the CLI and MCP server, are thin shells over these four functions;
// none of them re-implement retrieval or own the DB lifecycle.
//
// Authored in TypeScript with erasable-only syntax so Node can run it directly
// via type stripping in development, while the skill artifact ships the tsc
// output (Phase 6). The heavy internals (db/indexer/query) remain .mjs for now
// and are migrated in later phases; Core is the typed seam over them.

import { createContext, runInNewContext } from 'node:vm';

import { DB_PATH, openDb, openReadDb, openWriterLeaseDb } from './db.mjs';
import { buildIndex, shouldSkipBuild } from './indexer.mjs';
import { createQueryApi, createAttuneApi } from './query.mjs';
import { acquireWriterLease, writerLockPathFor } from './writer-lease.ts';

export { buildIndex, DB_PATH };

type SandboxApi = Record<string, unknown>;

// Run a user-supplied CodeAct script inside the query/attune sandbox. The script
// body runs as an async IIFE with a 30s timeout; its `return` value is resolved.
function runInSandbox(api: SandboxApi, scriptContent: string): Promise<unknown> {
  const sandbox = {
    ...api, JSON, Math, Array, Object, Set, Map, Date, RegExp,
    parseInt, parseFloat, String, Number, Boolean, Error, Promise, console, setTimeout,
  };
  const ctx = createContext(sandbox);
  return runInNewContext(`(async()=>{${scriptContent}})()`, ctx, { timeout: 30000 });
}

// FTS search over indexed message text. Refreshes the index, then queries.
export function searchText(text: string, opts?: Record<string, unknown>): unknown {
  buildIndex();
  const db = openReadDb();
  try {
    return createQueryApi(db).search(text, opts);
  } finally {
    db.close();
  }
}

// Execute a read-only CodeAct query script and resolve its returned value.
export async function executeQuery(scriptContent: string): Promise<unknown> {
  buildIndex();
  const db = openReadDb();
  try {
    return await runInSandbox(createQueryApi(db), scriptContent);
  } finally {
    db.close();
  }
}

// Execute a memory-mutation CodeAct script (remember/forget only).
export async function executeAttune(scriptContent: string): Promise<unknown> {
  const build = buildIndex() as { reason?: string } | undefined;
  if (build?.reason === 'daemon_active') {
    throw new Error('Obelisk daemon owns index writes; attune is read-only until the daemon stops');
  }
  if (build?.reason === 'writer_busy' || build?.reason === 'database_busy') {
    throw new Error('Obelisk index writer is busy; attune was not applied');
  }
  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(DB_PATH),
    openDb: openWriterLeaseDb,
    waitMs: 1000,
  });
  if (!lease) throw new Error('Obelisk index writer is busy; attune was not applied');
  try {
    // Close the heartbeat TOCTOU window after acquiring the hard lease.
    const ownershipDb = openReadDb();
    try {
      const ownership = shouldSkipBuild(ownershipDb, { ignoreRecentBuild: true });
      if (ownership.reason === 'daemon_active') {
        throw new Error('Obelisk daemon owns index writes; attune is read-only until the daemon stops');
      }
    } finally {
      ownershipDb.close();
    }
    const db = openDb();
    try {
      return await runInSandbox(createAttuneApi(db), scriptContent);
    } finally {
      db.close();
    }
  } finally {
    lease.release();
  }
}

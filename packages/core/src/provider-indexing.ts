import { persist } from './persist.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type { Cursor, IndexUnit, ProviderAdapter } from './providers/types.ts';
import type { SqliteDb } from './sqlite-types.ts';

export interface ProviderIndexItem {
  readonly provider: ProviderAdapter;
  readonly unit: IndexUnit;
  readonly cursor: Cursor;
}

export interface ProviderIndexPlan {
  readonly items: ProviderIndexItem[];
  readonly pendingMarkers: ReadonlyMap<string, string>;
}

export interface ProviderIndexResult {
  readonly committed: ProviderIndexItem[];
  readonly failedProviders: ReadonlySet<string>;
  readonly stopped?: { item: ProviderIndexItem; error: unknown };
}

export function storedProviderCursor(db: SqliteDb, key: string): Cursor {
  const row = db.prepare('SELECT mtime, lines_processed FROM index_state WHERE jsonl_path = ?').get(key);
  return row ? `${String(row.mtime)}:${String(row.lines_processed)}` : null;
}

function sourceAlreadyIndexed(db: SqliteDb, source: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sessions WHERE source = ? LIMIT 1').get(source));
}

export function createProviderIndexPlan(
  db: SqliteDb,
  registry: ProviderRegistry,
  { force = false, changedPaths }: { force?: boolean; changedPaths?: string[] } = {},
): ProviderIndexPlan {
  const items: ProviderIndexItem[] = [];
  const pendingMarkers = new Map<string, string>();
  for (const provider of registry.list()) {
    const marker = provider.indexVersionMarker;
    const markerMissing = marker !== undefined && !db.prepare(
      'SELECT jsonl_path FROM index_state WHERE jsonl_path = ?',
    ).get(marker);
    if (markerMissing) pendingMarkers.set(provider.name, marker);
    const fullReindex = force || (markerMissing && sourceAlreadyIndexed(db, provider.name));
    const units = provider.discover({
      lastCursor: fullReindex ? () => null : (key) => storedProviderCursor(db, key),
      changedPaths: fullReindex ? undefined : changedPaths,
    });
    for (const unit of units) {
      items.push({
        provider,
        unit,
        cursor: fullReindex ? null : storedProviderCursor(db, unit.key),
      });
    }
  }
  return { items, pendingMarkers };
}

export function indexProviderPlan({
  db,
  plan,
  runTransaction,
  onCommitted = () => {},
  onError,
}: {
  db: SqliteDb;
  plan: ProviderIndexPlan;
  runTransaction: <T>(label: string, work: () => T) => T;
  onCommitted?: (item: ProviderIndexItem, cursor: Cursor) => void;
  onError: (error: unknown, item: ProviderIndexItem) => 'skip' | 'stop';
}): ProviderIndexResult {
  const committed: ProviderIndexItem[] = [];
  const failedProviders = new Set<string>();
  for (const item of plan.items) {
    try {
      const cursor = runTransaction(`provider:${item.provider.name}:${item.unit.key}`, () => (
        persist(db, item.unit, item.provider.parse(item.unit, item.cursor))
      ));
      committed.push(item);
      onCommitted(item, cursor);
    } catch (error) {
      failedProviders.add(item.provider.name);
      if (onError(error, item) === 'stop') {
        return { committed, failedProviders, stopped: { item, error } };
      }
    }
  }
  return { committed, failedProviders };
}

export function writeProviderIndexMarkers(
  db: SqliteDb,
  plan: ProviderIndexPlan,
  result: ProviderIndexResult,
): void {
  const write = db.prepare(
    'INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)',
  );
  for (const [provider, marker] of plan.pendingMarkers) {
    if (!result.failedProviders.has(provider) && result.stopped === undefined) {
      write.run(marker, Date.now());
    }
  }
}

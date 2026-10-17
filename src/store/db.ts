import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface CacheEntry {
  key: string;
  value: unknown;
  /** Epoch ms after which the entry is stale. `Infinity` never expires. */
  expiresAt: number;
}

interface SpotinderDB extends DBSchema {
  /** Small singletons: tokens, pending PKCE login, settings. */
  kv: { key: string; value: unknown };
  /** API response cache, keyed by request URL or a custom key. */
  cache: { key: string; value: CacheEntry };
  /** Album URI → epoch ms it was last heard (from recently-played and right swipes). */
  plays: { key: string; value: number };
}

const DB_NAME = 'spotinder';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<SpotinderDB>> | undefined;

export function db(): Promise<IDBPDatabase<SpotinderDB>> {
  dbPromise ??= openDB<SpotinderDB>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      // Each schema change gets its own `if (oldVersion < N)` block so upgrades run in order.
      if (oldVersion < 1) {
        database.createObjectStore('kv');
        database.createObjectStore('cache', { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        database.createObjectStore('plays');
      }
    },
  });
  return dbPromise;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('kv', key)) as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', value, key);
}

export async function kvDelete(key: string): Promise<void> {
  await (await db()).delete('kv', key);
}

/** Async key/value cache with expiry. The Spotify client depends on this interface, not on IndexedDB. */
export interface ResponseCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
}

export const idbCache: ResponseCache = {
  async get(key) {
    const entry = await (await db()).get('cache', key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) return undefined;
    return entry.value;
  },
  async set(key, value, ttlMs) {
    await (await db()).put('cache', { key, value, expiresAt: Date.now() + ttlMs });
  },
};

/** Prefix for permanent Last.fm → Spotify mappings, which survive cache clears by default. */
export const MAPPING_PREFIX = 'map:';

export async function clearCache({ keepMappings = true } = {}): Promise<void> {
  const database = await db();
  if (!keepMappings) return database.clear('cache');
  const tx = database.transaction('cache', 'readwrite');
  for await (const cursor of tx.store) {
    if (!cursor.key.startsWith(MAPPING_PREFIX)) await cursor.delete();
  }
  await tx.done;
}

/** Records album plays, keeping the latest timestamp per album. */
export async function recordPlays(plays: Iterable<[albumUri: string, at: number]>): Promise<void> {
  const tx = (await db()).transaction('plays', 'readwrite');
  for (const [uri, at] of plays) {
    const prev = await tx.store.get(uri);
    if (prev === undefined || at > prev) await tx.store.put(at, uri);
  }
  await tx.done;
}

export async function getLastPlayed(): Promise<Map<string, number>> {
  const tx = (await db()).transaction('plays');
  const [keys, values] = await Promise.all([tx.store.getAllKeys(), tx.store.getAll()]);
  return new Map(keys.map((k, i) => [k, values[i]!]));
}

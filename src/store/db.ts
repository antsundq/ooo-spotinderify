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
}

const DB_NAME = 'spotinder';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<SpotinderDB>> | undefined;

export function db(): Promise<IDBPDatabase<SpotinderDB>> {
  dbPromise ??= openDB<SpotinderDB>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      // Later phases add stores here as `if (oldVersion < 2) { ... }`.
      if (oldVersion < 1) {
        database.createObjectStore('kv');
        database.createObjectStore('cache', { keyPath: 'key' });
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

export async function clearCache(): Promise<void> {
  await (await db()).clear('cache');
}

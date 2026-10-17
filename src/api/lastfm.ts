// Minimal Last.fm client. Docs: https://www.last.fm/api
// The API key is read-only and fine to ship in a personal client-side app.

import { config } from '../config';
import { idbCache, type ResponseCache } from '../store/db';

const API_URL = 'https://ws.audioscrobbler.com/2.0/';
const DAY = 24 * 60 * 60_000;
/** Last.fm error codes that are worth retrying: 11 service offline, 16 temporary error, 29 rate limit. */
const RETRYABLE = new Set([11, 16, 29]);

export class LastfmError extends Error {
  override name = 'LastfmError';
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Last.fm's JSON turns one-element lists into a bare object; this undoes that. */
export function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export interface LastfmDeps {
  apiKey: string | undefined;
  cache: ResponseCache;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function createLastfmClient(deps: LastfmDeps) {
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function call<T>(method: string, params: Record<string, string | number>, cacheTtlMs: number): Promise<T> {
    if (!deps.apiKey) throw new LastfmError(10, 'Missing VITE_LASTFM_API_KEY in .env.local');
    const url = new URL(API_URL);
    url.search = new URLSearchParams({
      method,
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      api_key: deps.apiKey,
      format: 'json',
    }).toString();
    // Cache key without the API key, so rotating keys keeps the cache.
    const cacheKey = `lastfm:${method}:${JSON.stringify(params)}`;
    const cached = await deps.cache.get(cacheKey);
    if (cached !== undefined) return cached as T;

    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url.toString());
      const json = (await res.json().catch(() => ({}))) as { error?: number; message?: string };
      if (json.error === undefined && res.ok) {
        await deps.cache.set(cacheKey, json, cacheTtlMs);
        return json as T;
      }
      const code = json.error ?? res.status;
      if (RETRYABLE.has(code) && attempt < 2) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new LastfmError(code, json.message ?? `Last.fm ${method} failed (${res.status})`);
    }
  }

  return {
    async similarArtists(artist: string, limit = 30): Promise<{ name: string; match: number }[]> {
      const res = await call<{ similarartists?: { artist?: LfArtist | LfArtist[] } }>(
        'artist.getSimilar',
        { artist, limit, autocorrect: 1 },
        7 * DAY,
      );
      return toArray(res.similarartists?.artist).map((a) => ({ name: a.name, match: Number(a.match) || 0 }));
    },

    async artistTopTags(artist: string): Promise<{ name: string; count: number }[]> {
      const res = await call<{ toptags?: { tag?: LfTag | LfTag[] } }>(
        'artist.getTopTags',
        { artist, autocorrect: 1 },
        30 * DAY,
      );
      return toArray(res.toptags?.tag).map((t) => ({ name: t.name, count: Number(t.count) || 0 }));
    },

    async tagTopAlbums(tag: string, page = 1, limit = 50): Promise<{ name: string; artist: string }[]> {
      const res = await call<{ albums?: { album?: LfAlbum | LfAlbum[] } }>(
        'tag.getTopAlbums',
        { tag, page, limit },
        7 * DAY,
      );
      return toArray(res.albums?.album).map((a) => ({ name: a.name, artist: a.artist.name }));
    },
  };
}

interface LfArtist {
  name: string;
  match?: string;
}

interface LfTag {
  name: string;
  count?: number | string;
}

interface LfAlbum {
  name: string;
  artist: { name: string };
}

export type LastfmClient = ReturnType<typeof createLastfmClient>;

export const lastfm = createLastfmClient({ apiKey: config.lastfmApiKey, cache: idbCache });

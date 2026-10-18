// Thin typed client for the Spotify Web API.
// Rate limits: https://developer.spotify.com/documentation/web-api/concepts/rate-limits
// Dev-mode quota: https://developer.spotify.com/documentation/web-api/concepts/quota-modes

import { getAccessToken } from '../auth/pkce';
import { idbCache, kvGet, kvSet, type ResponseCache } from '../store/db';

const API_BASE = 'https://api.spotify.com/v1';

/** Longest Retry-After we are willing to sleep through inside a request. Longer waits surface as errors. */
const MAX_INLINE_WAIT_S = 30;
/**
 * Dev-mode quota is shared across all my apps and resets on an unknown schedule, so stop calling for a while.
 * Spotify counts quota per bucket of endpoints, so the backoff only applies to the endpoint group that hit it:
 * running out on artist albums must not block playback.
 */
const QUOTA_BACKOFF_MS = 15 * 60_000;

/** Endpoint group used for quota backoff: "me/player", "me/albums", "artists", "search", "albums", … */
export function quotaGroup(url: string): string {
  const parts = new URL(url).pathname.replace(/^\/v1\//, '').split('/').filter(Boolean);
  return parts[0] === 'me' && parts[1] ? `me/${parts[1]}` : (parts[0] ?? '');
}

export type QuotaBlocks = Record<string, number>;

export class SpotifyApiError extends Error {
  override name = 'SpotifyApiError';
  constructor(
    readonly status: number,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** 429 from the rolling 30 s rate limit, with a Retry-After too long to wait inline. */
export class RateLimitError extends SpotifyApiError {
  override name = 'RateLimitError';
  constructor(readonly retryAfterS: number) {
    super(429, `Rate limited. Retry in ${retryAfterS}s.`);
  }
}

/** 429 with `reason: "QUOTA_EXCEEDED"`: the dev-mode quota is used up, not a short rate limit. */
export class QuotaExceededError extends SpotifyApiError {
  override name = 'QuotaExceededError';
  constructor(
    readonly blockedUntil: number,
    readonly group = '',
  ) {
    super(429, `Spotify dev-mode quota exceeded${group ? ` for ${group}` : ''}. Backing off.`, 'QUOTA_EXCEEDED');
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Cache successful GET responses for this long. Omit to skip the cache. */
  cacheTtlMs?: number;
}

export interface ClientDeps {
  getToken: (force: boolean) => Promise<string>;
  cache: ResponseCache;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
  /** Persists the quota backoff so a page reload doesn't start hammering the API again. */
  quotaStore?: { load(): Promise<QuotaBlocks | undefined>; save(blocks: QuotaBlocks): Promise<void> };
}

interface ErrorBody {
  error?: { status?: number; message?: string; reason?: string };
}

export function createSpotifyClient(deps: ClientDeps) {
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const maxRetries = deps.maxRetries ?? 3;

  let quotaBlocks: QuotaBlocks = {};
  let quotaLoaded = !deps.quotaStore;
  const inflight = new Map<string, Promise<unknown>>();

  function buildUrl(path: string, query: RequestOptions['query']): string {
    const url = new URL(path.startsWith('https://') ? path : API_BASE + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async function send<T>(url: string, opts: RequestOptions): Promise<T> {
    let forcedRefresh = false;
    for (let attempt = 0; ; attempt++) {
      if (!quotaLoaded) {
        quotaBlocks = { ...((await deps.quotaStore!.load()) ?? {}), ...quotaBlocks };
        quotaLoaded = true;
      }
      const group = quotaGroup(url);
      const blockedUntil = quotaBlocks[group] ?? 0;
      if (now() < blockedUntil) throw new QuotaExceededError(blockedUntil, group);

      const token = await deps.getToken(false);
      const res = await doFetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });

      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const body = (await res.json().catch(() => ({}))) as ErrorBody;
      const message = body.error?.message ?? res.statusText;

      if (res.status === 401 && !forcedRefresh) {
        // Token revoked or expired early; refresh once and retry.
        forcedRefresh = true;
        await deps.getToken(true);
        continue;
      }

      if (res.status === 429) {
        if (body.error?.reason === 'QUOTA_EXCEEDED') {
          const until = now() + QUOTA_BACKOFF_MS;
          // Drop expired entries while we're at it.
          quotaBlocks = Object.fromEntries(Object.entries(quotaBlocks).filter(([, t]) => t > now()));
          quotaBlocks[group] = until;
          await deps.quotaStore?.save(quotaBlocks);
          throw new QuotaExceededError(until, group);
        }
        // Retry-After is "normally" present; fall back to exponential backoff.
        const header = Number(res.headers.get('Retry-After'));
        const retryAfterS = Number.isFinite(header) && header > 0 ? header : 2 ** attempt;
        if (attempt >= maxRetries || retryAfterS > MAX_INLINE_WAIT_S) throw new RateLimitError(retryAfterS);
        await sleep(retryAfterS * 1000);
        continue;
      }

      if (res.status >= 500 && attempt < maxRetries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }

      throw new SpotifyApiError(res.status, message, body.error?.reason);
    }
  }

  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = buildUrl(path, opts.query);
    const cacheable = (opts.method ?? 'GET') === 'GET' && opts.cacheTtlMs !== undefined;
    if (!cacheable) return send<T>(url, opts);

    const cached = await deps.cache.get(url);
    if (cached !== undefined) return cached as T;

    // Collapse identical concurrent GETs into one network call.
    const existing = inflight.get(url);
    if (existing) return existing as Promise<T>;
    const p = send<T>(url, opts)
      .then(async (value) => {
        await deps.cache.set(url, value, opts.cacheTtlMs!);
        return value;
      })
      .finally(() => inflight.delete(url));
    inflight.set(url, p);
    return p;
  }

  return {
    request,
    get: <T>(path: string, query?: RequestOptions['query'], cacheTtlMs?: number) =>
      request<T>(path, { query, cacheTtlMs }),
    put: <T = void>(path: string, body?: unknown, query?: RequestOptions['query']) =>
      request<T>(path, { method: 'PUT', body, query }),
    post: <T = void>(path: string, body?: unknown, query?: RequestOptions['query']) =>
      request<T>(path, { method: 'POST', body, query }),
    del: <T = void>(path: string, body?: unknown, query?: RequestOptions['query']) =>
      request<T>(path, { method: 'DELETE', body, query }),
    /** Latest epoch ms until which some endpoint group fails fast after a QUOTA_EXCEEDED, or 0. */
    quotaBlockedUntil: () => Math.max(0, ...Object.values(quotaBlocks)),
  };
}

export type SpotifyClient = ReturnType<typeof createSpotifyClient>;

const QUOTA_KEY = 'spotify.quotaBlocks';

export const spotify = createSpotifyClient({
  getToken: getAccessToken,
  cache: idbCache,
  quotaStore: { load: () => kvGet<QuotaBlocks>(QUOTA_KEY), save: (blocks) => kvSet(QUOTA_KEY, blocks) },
});

// --- Endpoints ---------------------------------------------------------------

export interface SpotifyImage {
  url: string;
  width: number | null;
  height: number | null;
}

/** `GET /me`. Since Feb 2026, country, email, product, followers and explicit_content are no longer returned. */
export interface SpotifyUser {
  id: string;
  display_name: string | null;
  images?: SpotifyImage[];
  uri: string;
}

export function getMe(client: SpotifyClient = spotify): Promise<SpotifyUser> {
  return client.get<SpotifyUser>('/me', undefined, 60 * 60_000);
}

export interface SimplifiedArtist {
  id: string;
  name: string;
  uri: string;
}

export interface SpotifyArtist extends SimplifiedArtist {
  images: SpotifyImage[];
}

export interface SimplifiedAlbum {
  id: string;
  uri: string;
  name: string;
  album_type: 'album' | 'single' | 'compilation';
  release_date: string;
  release_date_precision: 'year' | 'month' | 'day';
  total_tracks: number;
  images: SpotifyImage[];
  artists: SimplifiedArtist[];
}

export interface Paging<T> {
  items: T[];
  next: string | null;
  total: number;
  offset: number;
  limit: number;
}

export interface SavedAlbum {
  added_at: string;
  album: SimplifiedAlbum;
}

export interface PlayHistory {
  played_at: string;
  track: { id: string; name: string; album: SimplifiedAlbum };
  context: { type: string; uri: string } | null;
}

export type TimeRange = 'short_term' | 'medium_term' | 'long_term';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** Follows `next` links until `maxItems` items are collected or the list ends. */
export async function paginate<T>(
  client: SpotifyClient,
  path: string,
  query: RequestOptions['query'],
  cacheTtlMs: number,
  maxItems = Infinity,
): Promise<T[]> {
  const items: T[] = [];
  let page = await client.get<Paging<T>>(path, query, cacheTtlMs);
  items.push(...page.items);
  while (page.next && items.length < maxItems) {
    page = await client.get<Paging<T>>(page.next, undefined, cacheTtlMs);
    items.push(...page.items);
  }
  return items.slice(0, maxItems);
}

/** `GET /me/albums`, all pages, cached 24 h. */
export function getSavedAlbums(client: SpotifyClient = spotify): Promise<SavedAlbum[]> {
  return paginate<SavedAlbum>(client, '/me/albums', { limit: 50 }, DAY);
}

/** `GET /me/player/recently-played`. Spotify only exposes the last 50 plays. */
export async function getRecentlyPlayed(client: SpotifyClient = spotify): Promise<PlayHistory[]> {
  const page = await client.get<Paging<PlayHistory>>('/me/player/recently-played', { limit: 50 }, 10 * 60_000);
  return page.items;
}

/** `GET /me/top/artists`, cached 24 h. */
export async function getTopArtists(timeRange: TimeRange, client: SpotifyClient = spotify): Promise<SpotifyArtist[]> {
  const page = await client.get<Paging<SpotifyArtist>>('/me/top/artists', { time_range: timeRange, limit: 50 }, DAY);
  return page.items;
}

/** Strips characters that Spotify's query parser treats specially. */
function searchTerm(s: string): string {
  return s.replace(/["':]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** `GET /search?type=artist`. At most 10 results per type since Feb 2026. */
export async function searchArtists(name: string, client: SpotifyClient = spotify): Promise<SpotifyArtist[]> {
  const res = await client.get<{ artists: Paging<SpotifyArtist> }>(
    '/search',
    { q: `artist:${searchTerm(name)}`, type: 'artist', limit: 10 },
    7 * DAY,
  );
  return res.artists.items;
}

/** `GET /search?type=album` for one artist + title. */
export async function searchAlbums(artist: string, title: string, client: SpotifyClient = spotify): Promise<SimplifiedAlbum[]> {
  const res = await client.get<{ albums: Paging<SimplifiedAlbum> }>(
    '/search',
    { q: `album:${searchTerm(title)} artist:${searchTerm(artist)}`, type: 'album', limit: 10 },
    7 * DAY,
  );
  return res.albums.items;
}

/** `GET /artists/{id}/albums?include_groups=album`. Pages are at most 10 since Feb 2026. */
export function getArtistAlbums(artistId: string, maxItems = 30, client: SpotifyClient = spotify): Promise<SimplifiedAlbum[]> {
  return paginate<SimplifiedAlbum>(
    client,
    `/artists/${encodeURIComponent(artistId)}/albums`,
    { include_groups: 'album', limit: 10 },
    7 * DAY,
    maxItems,
  );
}

export interface SimplifiedTrack {
  id: string;
  name: string;
  duration_ms: number;
  track_number: number;
  disc_number: number;
  artists: SimplifiedArtist[];
}

export interface FullAlbum extends SimplifiedAlbum {
  tracks: Paging<SimplifiedTrack>;
}

export interface AlbumDetails {
  album: FullAlbum;
  /** All tracks, following pagination past the first embedded page. */
  tracks: SimplifiedTrack[];
  totalMs: number;
}

/** `GET /albums/{id}` plus any further track pages, cached 7 days. */
export async function getAlbumDetails(albumId: string, client: SpotifyClient = spotify): Promise<AlbumDetails> {
  const album = await client.get<FullAlbum>(`/albums/${encodeURIComponent(albumId)}`, undefined, 7 * DAY);
  const tracks = [...album.tracks.items];
  let next = album.tracks.next;
  while (next) {
    const page = await client.get<Paging<SimplifiedTrack>>(next, undefined, 7 * DAY);
    tracks.push(...page.items);
    next = page.next;
  }
  return { album, tracks, totalMs: tracks.reduce((sum, t) => sum + t.duration_ms, 0) };
}

/** `PUT /me/library?uris=…` (replaced `PUT /me/albums` in Feb 2026). Max 40 URIs. */
export function saveToLibrary(uris: string[], client: SpotifyClient = spotify): Promise<void> {
  return client.put('/me/library', undefined, { uris: uris.join(',') });
}

/** `DELETE /me/library?uris=…`. Max 40 URIs. */
export function removeFromLibrary(uris: string[], client: SpotifyClient = spotify): Promise<void> {
  return client.del('/me/library', undefined, { uris: uris.join(',') });
}

export function albumIdFromUri(uri: string): string {
  return uri.split(':').pop() ?? uri;
}

// --- Player ----------------------------------------------------------------------

export interface SpotifyDevice {
  id: string | null;
  is_active: boolean;
  is_private_session: boolean;
  /** Restricted devices accept no Web API commands. */
  is_restricted: boolean;
  name: string;
  type: string;
  volume_percent: number | null;
}

/** `GET /me/player/devices`. Never cached: devices come and go. */
export async function getDevices(client: SpotifyClient = spotify): Promise<SpotifyDevice[]> {
  return (await client.get<{ devices: SpotifyDevice[] }>('/me/player/devices')).devices;
}

/** `PUT /me/player`: move playback to a device without starting it. */
export function transferPlayback(deviceId: string, client: SpotifyClient = spotify): Promise<void> {
  return client.put('/me/player', { device_ids: [deviceId], play: false });
}

/** `PUT /me/player/shuffle?state=…`. */
export function setShuffle(state: boolean, deviceId: string, client: SpotifyClient = spotify): Promise<void> {
  return client.put('/me/player/shuffle', undefined, { state, device_id: deviceId });
}

/** `PUT /me/player/play` with an album context, from track 1. */
export function playContext(contextUri: string, deviceId: string, client: SpotifyClient = spotify): Promise<void> {
  return client.put(
    '/me/player/play',
    { context_uri: contextUri, offset: { position: 0 }, position_ms: 0 },
    { device_id: deviceId },
  );
}

// Thin typed client for the Spotify Web API.
// Rate limits: https://developer.spotify.com/documentation/web-api/concepts/rate-limits
// Dev-mode quota: https://developer.spotify.com/documentation/web-api/concepts/quota-modes

import { getAccessToken } from '../auth/pkce';
import { idbCache, type ResponseCache } from '../store/db';

const API_BASE = 'https://api.spotify.com/v1';

/** Longest Retry-After we are willing to sleep through inside a request. Longer waits surface as errors. */
const MAX_INLINE_WAIT_S = 30;
/** Dev-mode quota is shared across all my apps and resets on an unknown schedule, so stop calling for a while. */
const QUOTA_BACKOFF_MS = 15 * 60_000;

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
  constructor(readonly blockedUntil: number) {
    super(429, 'Spotify dev-mode quota exceeded. Backing off.', 'QUOTA_EXCEEDED');
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
}

interface ErrorBody {
  error?: { status?: number; message?: string; reason?: string };
}

export function createSpotifyClient(deps: ClientDeps) {
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const maxRetries = deps.maxRetries ?? 3;

  let quotaBlockedUntil = 0;
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
      if (now() < quotaBlockedUntil) throw new QuotaExceededError(quotaBlockedUntil);

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
          quotaBlockedUntil = now() + QUOTA_BACKOFF_MS;
          throw new QuotaExceededError(quotaBlockedUntil);
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
    /** Epoch ms until which calls fail fast after a QUOTA_EXCEEDED, or 0. */
    quotaBlockedUntil: () => quotaBlockedUntil,
  };
}

export type SpotifyClient = ReturnType<typeof createSpotifyClient>;

export const spotify = createSpotifyClient({ getToken: getAccessToken, cache: idbCache });

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

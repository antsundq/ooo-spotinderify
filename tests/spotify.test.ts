import { describe, expect, it, vi } from 'vitest';
import {
  createSpotifyClient,
  QuotaExceededError,
  quotaGroup,
  RateLimitError,
  SpotifyApiError,
  type ClientDeps,
} from '../src/api/spotify';
import type { ResponseCache } from '../src/store/db';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function memoryCache(): ResponseCache {
  const map = new Map<string, unknown>();
  return {
    get: async (k) => map.get(k),
    set: async (k, v) => void map.set(k, v),
  };
}

function setup(responses: Response[], overrides: Partial<ClientDeps> = {}) {
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  });
  const sleep = vi.fn(async () => {});
  const getToken = vi.fn(async (force: boolean) => (force ? 'fresh' : 'stale'));
  let t = 1_000_000;
  const client = createSpotifyClient({
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep,
    getToken,
    cache: memoryCache(),
    now: () => t,
    ...overrides,
  });
  return { client, fetch, sleep, getToken, advance: (ms: number) => (t += ms) };
}

describe('spotify client', () => {
  it('attaches the bearer token and builds query strings', async () => {
    const { client, fetch } = setup([json(200, { id: 'me' })]);
    await client.get('/me/albums', { limit: 50, offset: undefined });
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    const [url, init] = calls[0]!;
    expect(url).toBe('https://api.spotify.com/v1/me/albums?limit=50');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer stale');
  });

  it('waits Retry-After on 429 and retries', async () => {
    const { client, sleep } = setup([json(429, {}, { 'Retry-After': '2' }), json(200, { ok: true })]);
    await expect(client.get('/me')).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('throws RateLimitError when Retry-After is too long to wait', async () => {
    const { client, sleep } = setup([json(429, {}, { 'Retry-After': '120' })]);
    await expect(client.get('/me')).rejects.toBeInstanceOf(RateLimitError);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after maxRetries 429s', async () => {
    const r = () => json(429, {}, { 'Retry-After': '1' });
    const { client } = setup([r(), r(), r(), r()]);
    await expect(client.get('/me')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('treats QUOTA_EXCEEDED as a hard stop and fails fast afterwards', async () => {
    const quota = { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } };
    const { client, fetch, sleep, advance } = setup([json(429, quota, { 'Retry-After': '1' }), json(200, { ok: 1 })]);

    await expect(client.get('/me')).rejects.toBeInstanceOf(QuotaExceededError);
    expect(sleep).not.toHaveBeenCalled();

    await expect(client.get('/me')).rejects.toBeInstanceOf(QuotaExceededError);
    expect(fetch).toHaveBeenCalledTimes(1);

    advance(16 * 60_000);
    await expect(client.get('/me')).resolves.toEqual({ ok: 1 });
  });

  it('persists the quota backoff and honours it after a reload', async () => {
    const quota = { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } };
    let stored: Record<string, number> | undefined;
    const quotaStore = { load: async () => stored, save: async (b: Record<string, number>) => void (stored = { ...b }) };
    const first = setup([json(429, quota)], { quotaStore });
    await expect(first.client.get('/me')).rejects.toBeInstanceOf(QuotaExceededError);
    expect(stored?.me).toBeGreaterThan(1_000_000);

    // A fresh client (page reload) must not call the API while the stored block lasts.
    const second = setup([json(200, { ok: 1 })], { quotaStore });
    await expect(second.client.get('/me')).rejects.toBeInstanceOf(QuotaExceededError);
    expect(second.fetch).not.toHaveBeenCalled();
  });

  it('only blocks the endpoint group that ran out of quota', async () => {
    const quota = { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } };
    const { client, fetch } = setup([json(429, quota), new Response(null, { status: 204 })]);
    await expect(client.get('/artists/x/albums')).rejects.toMatchObject({ group: 'artists' });
    // Playback is a different bucket and must still go through.
    await expect(client.put('/me/player/play', { context_uri: 'spotify:album:x' })).resolves.toBeUndefined();
    // Another artist call fails fast without a request.
    await expect(client.get('/artists/y/albums')).rejects.toBeInstanceOf(QuotaExceededError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('groups endpoints by their first path segments', () => {
    expect(quotaGroup('https://api.spotify.com/v1/me/player/play?device_id=1')).toBe('me/player');
    expect(quotaGroup('https://api.spotify.com/v1/me/albums?offset=50')).toBe('me/albums');
    expect(quotaGroup('https://api.spotify.com/v1/me')).toBe('me');
    expect(quotaGroup('https://api.spotify.com/v1/artists/abc/albums')).toBe('artists');
    expect(quotaGroup('https://api.spotify.com/v1/search?q=x')).toBe('search');
  });

  it('refreshes the token once on 401', async () => {
    const { client, getToken } = setup([json(401, { error: { message: 'expired' } }), json(200, { ok: true })]);
    await expect(client.get('/me')).resolves.toEqual({ ok: true });
    expect(getToken).toHaveBeenCalledWith(true);
  });

  it('does not loop on repeated 401s', async () => {
    const r = () => json(401, { error: { message: 'nope' } });
    const { client } = setup([r(), r()]);
    await expect(client.get('/me')).rejects.toMatchObject({ status: 401 });
  });

  it('surfaces other errors with status and message', async () => {
    const { client } = setup([json(404, { error: { status: 404, message: 'Not found' } })]);
    const err = await client.get('/albums/x').catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyApiError);
    expect(err).toMatchObject({ status: 404, message: 'Not found' });
  });

  it('caches GETs with a TTL and dedupes concurrent requests', async () => {
    const { client, fetch } = setup([json(200, { n: 1 })]);
    const [a, b] = await Promise.all([client.get('/me', undefined, 1000), client.get('/me', undefined, 1000)]);
    const c = await client.get('/me', undefined, 1000);
    expect([a, b, c]).toEqual([{ n: 1 }, { n: 1 }, { n: 1 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('handles 204 No Content', async () => {
    const { client } = setup([new Response(null, { status: 204 })]);
    await expect(client.put('/me/player/play', { context_uri: 'spotify:album:x' })).resolves.toBeUndefined();
  });
});

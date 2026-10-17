import { describe, expect, it, vi } from 'vitest';
import { createSpotifyClient, type SpotifyDevice } from '../src/api/spotify';
import { NO_DEVICES_MESSAGE, planPlayback, playAlbum } from '../src/ui/player';

function device(name: string, extra: Partial<SpotifyDevice> = {}): SpotifyDevice {
  return {
    id: `id-${name}`,
    is_active: false,
    is_private_session: false,
    is_restricted: false,
    name,
    type: 'Speaker',
    volume_percent: 50,
    ...extra,
  };
}

describe('planPlayback', () => {
  it('plays on the active device', () => {
    const plan = planPlayback([device('a'), device('b', { is_active: true })]);
    expect(plan).toMatchObject({ kind: 'play', device: { name: 'b' } });
  });

  it('asks when devices exist but none is active', () => {
    const plan = planPlayback([device('a'), device('b')]);
    expect(plan.kind).toBe('pick');
  });

  it('ignores restricted and id-less devices', () => {
    expect(planPlayback([device('r', { is_restricted: true, is_active: true }), device('n', { id: null })]).kind).toBe('none');
    expect(planPlayback([]).kind).toBe('none');
  });
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** A Spotify client whose fetch records calls and answers from a route table. */
function fakeSpotify(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const call: Call = { method: init.method ?? 'GET', path: u.pathname.replace('/v1', '') + u.search, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    const key = `${call.method} ${u.pathname.replace('/v1', '')}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    return handler(call);
  });
  const client = createSpotifyClient({
    fetch: fetch as unknown as typeof globalThis.fetch,
    getToken: async () => 't',
    cache: { get: async () => undefined, set: async () => {} },
    sleep: async () => {},
  });
  return { client, calls };
}

const ok204 = () => new Response(null, { status: 204 });
const devicesResponse = (devices: SpotifyDevice[]) => () => new Response(JSON.stringify({ devices }), { status: 200 });
const card = { uri: 'spotify:album:abc', name: 'Rumours' };

describe('playAlbum', () => {
  it('turns shuffle off, then plays the album from track 1 on the active device', async () => {
    const { client, calls } = fakeSpotify({
      'GET /me/player/devices': devicesResponse([device('Kitchen', { is_active: true })]),
      'PUT /me/player/shuffle': ok204,
      'PUT /me/player/play': ok204,
    });
    const pickDevice = vi.fn();
    const result = await playAlbum(card, { client, pickDevice });

    expect(result).toMatchObject({ ok: true, message: 'Playing “Rumours” on Kitchen' });
    expect(pickDevice).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method + ' ' + c.path)).toEqual([
      'GET /me/player/devices',
      'PUT /me/player/shuffle?state=false&device_id=id-Kitchen',
      'PUT /me/player/play?device_id=id-Kitchen',
    ]);
    expect(calls[2]!.body).toEqual({ context_uri: 'spotify:album:abc', offset: { position: 0 }, position_ms: 0 });
  });

  it('shows the picker, transfers, then plays when no device is active', async () => {
    const { client, calls } = fakeSpotify({
      'GET /me/player/devices': devicesResponse([device('Desk'), device('Phone')]),
      'PUT /me/player': ok204,
      'PUT /me/player/shuffle': ok204,
      'PUT /me/player/play': ok204,
    });
    const pickDevice = vi.fn(async (devices: SpotifyDevice[]) => devices[1]);
    const result = await playAlbum(card, { client, pickDevice });

    expect(result.ok).toBe(true);
    expect(pickDevice.mock.calls[0]![0].map((d) => d.name)).toEqual(['Desk', 'Phone']);
    expect(calls[1]).toMatchObject({ method: 'PUT', path: '/me/player', body: { device_ids: ['id-Phone'], play: false } });
    expect(calls.at(-1)!.path).toBe('/me/player/play?device_id=id-Phone');
  });

  it('retries play once when a just-transferred device is not ready', async () => {
    let plays = 0;
    const { client } = fakeSpotify({
      'GET /me/player/devices': devicesResponse([device('Desk')]),
      'PUT /me/player': ok204,
      'PUT /me/player/shuffle': ok204,
      'PUT /me/player/play': () =>
        ++plays === 1 ? new Response(JSON.stringify({ error: { status: 404, message: 'Device not found' } }), { status: 404 }) : ok204(),
    });
    const result = await playAlbum(card, { client, pickDevice: async (d) => d[0] });
    expect(result.ok).toBe(true);
    expect(plays).toBe(2);
  });

  it('says to open Spotify when there are no devices', async () => {
    const { client, calls } = fakeSpotify({ 'GET /me/player/devices': devicesResponse([]) });
    const result = await playAlbum(card, { client, pickDevice: vi.fn() });
    expect(result).toEqual({ ok: false, message: NO_DEVICES_MESSAGE });
    expect(calls).toHaveLength(1);
  });

  it('does nothing when the picker is cancelled', async () => {
    const { client, calls } = fakeSpotify({ 'GET /me/player/devices': devicesResponse([device('Desk')]) });
    const result = await playAlbum(card, { client, pickDevice: async () => undefined });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('still plays if setting shuffle fails', async () => {
    const { client } = fakeSpotify({
      'GET /me/player/devices': devicesResponse([device('Desk', { is_active: true })]),
      'PUT /me/player/shuffle': () => new Response(JSON.stringify({ error: { status: 403, message: 'Restricted' } }), { status: 403 }),
      'PUT /me/player/play': ok204,
    });
    expect((await playAlbum(card, { client, pickDevice: vi.fn() })).ok).toBe(true);
  });

  it('explains a 403 from play', async () => {
    const { client } = fakeSpotify({
      'GET /me/player/devices': devicesResponse([device('Desk', { is_active: true })]),
      'PUT /me/player/shuffle': ok204,
      'PUT /me/player/play': () => new Response(JSON.stringify({ error: { status: 403, message: 'Premium required' } }), { status: 403 }),
    });
    const result = await playAlbum(card, { client, pickDevice: vi.fn() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Premium');
  });
});

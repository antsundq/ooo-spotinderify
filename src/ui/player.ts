// Playback on right swipe, the device picker and the now-playing mini-bar.

import {
  albumIdFromUri,
  getDevices,
  playContext,
  setShuffle,
  spotify,
  SpotifyApiError,
  transferPlayback,
  type SpotifyClient,
  type SpotifyDevice,
} from '../api/spotify';
import type { DeckCard } from '../mixer/deck';
import { createCardElement, escapeHtml, toggleFlip } from './card';

export type PlayPlan =
  | { kind: 'play'; device: SpotifyDevice }
  | { kind: 'pick'; devices: SpotifyDevice[] }
  | { kind: 'none' };

/** Devices that can take Web API commands. */
export function usableDevices(devices: SpotifyDevice[]): SpotifyDevice[] {
  return devices.filter((d) => d.id && !d.is_restricted);
}

/** Active device → play there. Devices but none active → ask. No devices → tell the user. */
export function planPlayback(devices: SpotifyDevice[]): PlayPlan {
  const usable = usableDevices(devices);
  if (!usable.length) return { kind: 'none' };
  const active = usable.find((d) => d.is_active);
  return active ? { kind: 'play', device: active } : { kind: 'pick', devices: usable };
}

export interface PlayResult {
  ok: boolean;
  message: string;
  device?: SpotifyDevice;
}

export interface PlayDeps {
  /** Shows a device picker; resolves undefined if the user cancels. */
  pickDevice: (devices: SpotifyDevice[]) => Promise<SpotifyDevice | undefined>;
  client?: SpotifyClient;
  sleep?: (ms: number) => Promise<void>;
}

export const NO_DEVICES_MESSAGE = 'Open Spotify on a device first.';

export async function playAlbum(card: Pick<DeckCard, 'uri' | 'name'>, deps: PlayDeps): Promise<PlayResult> {
  const client = deps.client ?? spotify;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    const plan = planPlayback(await getDevices(client));
    if (plan.kind === 'none') return { ok: false, message: NO_DEVICES_MESSAGE };

    let device: SpotifyDevice;
    let transferred = false;
    if (plan.kind === 'pick') {
      const picked = await deps.pickDevice(plan.devices);
      if (!picked) return { ok: false, message: 'Not played. No device picked.' };
      device = picked;
      await transferPlayback(device.id!, client);
      transferred = true;
    } else {
      device = plan.device;
    }

    // Albums should play in order. A failure here (e.g. nothing loaded yet) shouldn't block playback.
    await setShuffle(false, device.id!, client).catch(() => undefined);
    try {
      await playContext(card.uri, device.id!, client);
    } catch (err) {
      // A freshly transferred device can take a moment to accept commands.
      if (!transferred || !(err instanceof SpotifyApiError) || err.status !== 404) throw err;
      await sleep(800);
      await playContext(card.uri, device.id!, client);
    }
    return { ok: true, message: `Playing “${card.name}” on ${device.name}`, device };
  } catch (err) {
    return { ok: false, message: playErrorMessage(err) };
  }
}

function playErrorMessage(err: unknown): string {
  if (err instanceof SpotifyApiError) {
    if (err.status === 404) return `${NO_DEVICES_MESSAGE} (${err.message})`;
    if (err.status === 403) return `Spotify refused playback: ${err.message}. Premium is required.`;
    return `Couldn't play: ${err.message}`;
  }
  return `Couldn't play: ${err instanceof Error ? err.message : String(err)}`;
}

// --- UI ------------------------------------------------------------------------

const DEVICE_ICON: Record<string, string> = {
  computer: '💻',
  smartphone: '📱',
  speaker: '🔊',
  tv: '📺',
  tablet: '📱',
  castvideo: '📺',
  castaudio: '🔊',
  automobile: '🚗',
};

/** Modal device list. Resolves with the chosen device, or undefined if dismissed. */
export function showDevicePicker(host: HTMLElement, devices: SpotifyDevice[]): Promise<SpotifyDevice | undefined> {
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet';
  dialog.innerHTML = `
    <h2>Play on…</h2>
    <p class="muted">No device is active. Pick one:</p>
    <ul class="device-list">
      ${devices
        .map(
          (d, i) => `
        <li><button class="device" data-i="${i}">
          <span aria-hidden="true">${DEVICE_ICON[d.type.toLowerCase()] ?? '🎵'}</span>
          <span>${escapeHtml(d.name)}</span>
          <span class="muted">${escapeHtml(d.type)}</span>
        </button></li>`,
        )
        .join('')}
    </ul>
    <button class="secondary" data-cancel>Cancel</button>`;
  host.append(dialog);
  dialog.showModal();
  return new Promise((resolve) => {
    let picked: SpotifyDevice | undefined;
    dialog.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const button = target.closest<HTMLElement>('[data-i]');
      if (button) picked = devices[Number(button.dataset.i)];
      if (button || target.closest('[data-cancel]') || target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(picked);
    });
  });
}

/** Mini-bar showing the album last started from the app. Tap opens its card. */
export function renderNowPlaying(bar: HTMLElement, card: DeckCard, device: SpotifyDevice): void {
  bar.hidden = false;
  bar.innerHTML = `
    <button class="np-open" aria-label="Show now playing album">
      ${card.coverUrl ? `<img src="${escapeHtml(card.coverUrl)}" alt="" width="40" height="40">` : ''}
      <span class="np-text">
        <strong>${escapeHtml(card.name)}</strong>
        <span>${escapeHtml(card.artist)} · on ${escapeHtml(device.name)}</span>
      </span>
    </button>`;
  bar.querySelector('.np-open')!.addEventListener('click', () => showPlayingCard(bar, card));
}

function showPlayingCard(host: HTMLElement, card: DeckCard): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'card-dialog';
  const el = createCardElement(card);
  el.classList.add('static');
  el.addEventListener('click', () => toggleFlip(el));
  dialog.append(el);
  const actions = document.createElement('div');
  actions.className = 'card-dialog-actions';
  actions.innerHTML = `
    <a class="button-link" href="https://open.spotify.com/album/${encodeURIComponent(albumIdFromUri(card.uri))}" target="_blank" rel="noopener">Open in Spotify</a>
    <button class="secondary" data-close>Close</button>`;
  dialog.append(actions);
  host.append(dialog);
  dialog.showModal();
  dialog.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target === dialog || target.closest('[data-close]')) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
}

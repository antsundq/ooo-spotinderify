// Album card: cover, title, artist, year and source badge on the front; tracklist on the back.

import { albumIdFromUri, getAlbumDetails, type AlbumDetails } from '../api/spotify';
import type { DeckCard } from '../mixer/deck';
import { sourceLabel } from '../pools/types';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  return `${Math.floor(totalMin / 60)} h ${totalMin % 60} min`;
}

function formatTrackTime(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function createCardElement(card: DeckCard): HTMLElement {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.uri = card.uri;
  el.setAttribute('aria-label', `${card.name} by ${card.artist}`);
  const cover = card.coverUrl
    ? `<img class="cover" src="${escapeHtml(card.coverUrl)}" alt="" draggable="false" decoding="async">`
    : `<div class="cover cover-missing"></div>`;
  el.innerHTML = `
    <div class="card-inner">
      <div class="face front">
        ${cover}
        <span class="stamp stamp-right">Play</span>
        <span class="stamp stamp-left">Skip</span>
        <span class="stamp stamp-up">Save</span>
        <span class="stamp stamp-down">Later</span>
        <div class="meta">
          <span class="source">${escapeHtml(sourceLabel(card.source))}</span>
          <h2>${escapeHtml(card.name)}</h2>
          <p>${escapeHtml(card.artist)}${card.year ? ` · ${card.year}` : ''}</p>
        </div>
      </div>
      <div class="face back" aria-hidden="true">
        <h2>${escapeHtml(card.name)}</h2>
        <p class="muted" data-summary>Loading tracks…</p>
        <ol class="tracklist" data-tracks></ol>
      </div>
    </div>`;
  return el;
}

const detailsCache = new Map<string, Promise<AlbumDetails>>();

/** Flips the card; the first flip fetches the tracklist. */
export function toggleFlip(el: HTMLElement): void {
  const flipped = el.classList.toggle('flipped');
  el.querySelector('.back')!.setAttribute('aria-hidden', String(!flipped));
  el.querySelector('.front')!.setAttribute('aria-hidden', String(flipped));
  if (flipped && !el.dataset.loaded) {
    el.dataset.loaded = '1';
    void loadBack(el);
  }
}

async function loadBack(el: HTMLElement): Promise<void> {
  const uri = el.dataset.uri!;
  const summary = el.querySelector<HTMLElement>('[data-summary]')!;
  const list = el.querySelector<HTMLElement>('[data-tracks]')!;
  try {
    let p = detailsCache.get(uri);
    if (!p) {
      p = getAlbumDetails(albumIdFromUri(uri));
      detailsCache.set(uri, p);
      p.catch(() => detailsCache.delete(uri));
    }
    const { tracks, totalMs } = await p;
    const multiDisc = tracks.some((t) => t.disc_number > 1);
    summary.textContent = `${tracks.length} tracks · ${formatDuration(totalMs)}`;
    list.innerHTML = tracks
      .map(
        (t) => `
        <li>
          <span class="track-no">${multiDisc ? `${t.disc_number}.` : ''}${t.track_number}</span>
          <span class="track-name">${escapeHtml(t.name)}</span>
          <span class="track-time">${formatTrackTime(t.duration_ms)}</span>
        </li>`,
      )
      .join('');
  } catch (err) {
    delete el.dataset.loaded;
    summary.textContent = `Couldn't load tracks: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const preloaded = new Set<string>();

/** Starts downloading covers for upcoming cards so they appear instantly. */
export function preloadCovers(cards: readonly DeckCard[]): void {
  for (const c of cards) {
    if (!c.coverUrl || preloaded.has(c.coverUrl)) continue;
    preloaded.add(c.coverUrl);
    new Image().src = c.coverUrl;
  }
}

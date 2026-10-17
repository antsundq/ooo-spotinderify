// Debug page: builds each candidate pool and lists the first 20 with cover art.

import { QuotaExceededError } from '../api/spotify';
import { adjacentPool } from '../pools/adjacent';
import { favoritesPool } from '../pools/favorites';
import { sourceLabel, type AlbumCandidate } from '../pools/types';
import { wildcardPool } from '../pools/wildcard';

const POOLS: { id: string; title: string; build: () => Promise<AlbumCandidate[]> }[] = [
  { id: 'favorites', title: 'Favorites', build: favoritesPool },
  { id: 'adjacent', title: 'Adjacent', build: () => adjacentPool({ count: 20 }) },
  { id: 'wildcard', title: 'Wildcard', build: () => wildcardPool({ count: 20 }) },
];

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function tile(c: AlbumCandidate): string {
  const cover = c.coverUrl
    ? `<img src="${escape(c.coverUrl)}" alt="" loading="lazy" width="300" height="300">`
    : `<div class="no-cover"></div>`;
  return `
    <li class="tile">
      ${cover}
      <div class="tile-text">
        <strong>${escape(c.name)}</strong>
        <span>${escape(c.artist)}${c.year ? ` · ${c.year}` : ''}</span>
        <span class="badge">${escape(sourceLabel(c.source))}</span>
        <span class="muted">score ${c.score.toFixed(2)}</span>
      </div>
    </li>`;
}

export function renderDebug(root: HTMLElement): void {
  root.innerHTML = `
    <section class="debug">
      <header class="debug-header">
        <a href="#/">← Back</a>
        <h1>Pools</h1>
      </header>
      ${POOLS.map(
        (p) => `
        <section class="pool" id="pool-${p.id}">
          <h2>${p.title} <span class="muted" data-status>loading…</span></h2>
          <ul class="tiles"></ul>
        </section>`,
      ).join('')}
    </section>`;

  for (const pool of POOLS) {
    const section = root.querySelector<HTMLElement>(`#pool-${pool.id}`)!;
    const status = section.querySelector<HTMLElement>('[data-status]')!;
    const list = section.querySelector<HTMLElement>('.tiles')!;
    const started = performance.now();
    pool
      .build()
      .then((candidates) => {
        const ms = Math.round(performance.now() - started);
        status.textContent = `${candidates.length} candidates · ${ms} ms`;
        list.innerHTML = candidates.slice(0, 20).map(tile).join('');
      })
      .catch((err: unknown) => {
        console.error(err);
        status.textContent = '';
        const message =
          err instanceof QuotaExceededError
            ? `Quota exceeded; paused until ${new Date(err.blockedUntil).toLocaleTimeString()}`
            : err instanceof Error
              ? err.message
              : String(err);
        list.innerHTML = `<li class="error">${escape(message)}</li>`;
      });
  }
}

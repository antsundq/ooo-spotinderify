// Debug page: the live deck with the discovery slider, plus on-demand raw pool listings.

import { QuotaExceededError } from '../api/spotify';
import { expireAccessToken, getAccessToken, getTokens } from '../auth/pkce';
import type { Deck, DeckCard } from '../mixer/deck';
import { loadSwipeState, makeSwipe, recordSwipe, undoSwipe } from '../mixer/history';
import { createLiveDeck, saveSlider } from '../mixer/live';
import { poolWeights, POOL_IDS, type PoolId, type SwipeDir } from '../mixer/scoring';
import { adjacentPool } from '../pools/adjacent';
import { favoritesPool } from '../pools/favorites';
import { sourceLabel, type AlbumCandidate } from '../pools/types';
import { wildcardPool } from '../pools/wildcard';
import type { Swipe } from '../store/db';

const POOLS: { id: PoolId; title: string; build: () => Promise<AlbumCandidate[]> }[] = [
  { id: 'favorites', title: 'Favorites', build: favoritesPool },
  { id: 'adjacent', title: 'Adjacent', build: () => adjacentPool({ count: 20 }) },
  { id: 'wildcard', title: 'Wildcard', build: () => wildcardPool({ count: 20 }) },
];

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function errorMessage(err: unknown): string {
  if (err instanceof QuotaExceededError) return `Quota exceeded; paused until ${new Date(err.blockedUntil).toLocaleTimeString()}`;
  return err instanceof Error ? err.message : String(err);
}

function tile(c: AlbumCandidate, extra = ''): string {
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
      ${extra}
    </li>`;
}

async function showToken(el: HTMLElement): Promise<void> {
  const tokens = await getTokens();
  el.textContent = tokens ? `Access token valid until ${new Date(tokens.expiresAt).toLocaleTimeString()}` : 'Not logged in';
}

function percent(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function renderDebug(root: HTMLElement): void {
  root.innerHTML = `
    <section class="debug">
      <header class="debug-header">
        <a href="#/">← Back</a>
        <h1>Debug</h1>
      </header>
      <p class="muted" data-token></p>
      <button class="secondary" data-expire>Expire access token &amp; refresh</button>

      <section class="pool" id="deck">
        <h2>Deck <span class="muted" data-status>loading…</span></h2>
        <label class="slider">
          <span>Favorites</span>
          <input type="range" min="0" max="100" step="5" data-slider>
          <span>Discovery</span>
        </label>
        <p class="muted" data-mix></p>
        <p class="muted" data-pools></p>
        <p class="deck-actions">
          <button class="secondary" data-undo disabled>Undo last swipe</button>
        </p>
        <ul class="tiles" data-cards></ul>
      </section>

      <section class="pool">
        <h2>Raw pools</h2>
        <button class="secondary" data-raw>Build raw pools</button>
        <div data-raw-list></div>
      </section>
    </section>`;

  void mountDeck(root.querySelector<HTMLElement>('#deck')!);
  void showToken(root.querySelector<HTMLElement>('[data-token]')!);
  root.querySelector('[data-expire]')!.addEventListener('click', async () => {
    await expireAccessToken();
    await getAccessToken();
    await showToken(root.querySelector<HTMLElement>('[data-token]')!);
  });

  root.querySelector<HTMLButtonElement>('[data-raw]')!.addEventListener('click', (e) => {
    (e.currentTarget as HTMLButtonElement).remove();
    renderRawPools(root.querySelector<HTMLElement>('[data-raw-list]')!);
  });
}

async function mountDeck(section: HTMLElement): Promise<void> {
  const status = section.querySelector<HTMLElement>('[data-status]')!;
  const mix = section.querySelector<HTMLElement>('[data-mix]')!;
  const pools = section.querySelector<HTMLElement>('[data-pools]')!;
  const list = section.querySelector<HTMLElement>('[data-cards]')!;
  const slider = section.querySelector<HTMLInputElement>('[data-slider]')!;
  const undoButton = section.querySelector<HTMLButtonElement>('[data-undo]')!;
  const undoStack: { swipe: Swipe; card: DeckCard }[] = [];

  let deck: Deck;
  const render = () => {
    const weights = poolWeights(deck.slider);
    const counts = { favorites: 0, adjacent: 0, wildcard: 0 } as Record<PoolId, number>;
    for (const c of deck.cards) counts[c.pool]++;
    status.textContent = `${deck.cards.length} cards ready`;
    mix.textContent =
      `Slider ${deck.slider} → target ` +
      POOL_IDS.map((id) => `${id} ${percent(weights[id])}`).join(' / ') +
      ` · in deck: ` +
      POOL_IDS.map((id) => `${id} ${counts[id]}`).join(' / ');
    const st = deck.poolStatus();
    pools.textContent = POOL_IDS.map(
      (id) => `${id}: ${st[id].building ? 'building… ' : ''}${st[id].available} left${st[id].error ? ` (error: ${st[id].error})` : ''}`,
    ).join(' · ');
    list.innerHTML = deck.cards
      .map((c, i) =>
        tile(
          c,
          i === 0
            ? `<div class="swipe-buttons">
                 <button class="secondary" data-swipe="left" title="Skip">←</button>
                 <button class="secondary" data-swipe="up" title="Save (recorded only)">↑</button>
                 <button data-swipe="right" title="Like (recorded only, no playback yet)">→</button>
               </div>`
            : `<span class="pool-tag">${c.pool}</span>`,
        ),
      )
      .join('');
    undoButton.disabled = undoStack.length === 0;
  };

  try {
    deck = await createLiveDeck(() => render());
  } catch (err) {
    status.textContent = errorMessage(err);
    return;
  }
  slider.value = String(deck.slider);
  render();
  deck.start().catch((err: unknown) => (status.textContent = errorMessage(err)));

  slider.addEventListener('input', () => {
    deck.setSlider(Number(slider.value));
    void saveSlider(Number(slider.value));
  });

  list.addEventListener('click', async (e) => {
    const dir = (e.target as HTMLElement).closest<HTMLElement>('[data-swipe]')?.dataset.swipe as SwipeDir | undefined;
    const card = deck.cards[0];
    if (!dir || !card) return;
    const swipe = makeSwipe(card, dir);
    swipe.id = await recordSwipe(swipe);
    undoStack.push({ swipe, card });
    deck.swiped(swipe);
  });

  undoButton.addEventListener('click', async () => {
    const last = undoStack.pop();
    if (!last?.swipe.id) return;
    await undoSwipe(last.swipe.id);
    deck.restore(last.card, await loadSwipeState());
  });
}

function renderRawPools(container: HTMLElement): void {
  container.innerHTML = POOLS.map(
    (p) => `
      <section class="pool" id="pool-${p.id}">
        <h2>${p.title} <span class="muted" data-status>loading…</span></h2>
        <ul class="tiles"></ul>
      </section>`,
  ).join('');

  for (const pool of POOLS) {
    const section = container.querySelector<HTMLElement>(`#pool-${pool.id}`)!;
    const status = section.querySelector<HTMLElement>('[data-status]')!;
    const list = section.querySelector<HTMLElement>('.tiles')!;
    const started = performance.now();
    pool
      .build()
      .then((candidates) => {
        const ms = Math.round(performance.now() - started);
        status.textContent = `${candidates.length} candidates · ${ms} ms`;
        list.innerHTML = candidates.slice(0, 20).map((c) => tile(c)).join('');
      })
      .catch((err: unknown) => {
        console.error(err);
        status.textContent = '';
        list.innerHTML = `<li class="error">${escape(errorMessage(err))}</li>`;
      });
  }
}

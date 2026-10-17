// Wires the deck to the real pools, the stored swipe history and the saved slider position.

import { adjacentPool } from '../pools/adjacent';
import { favoritesPool } from '../pools/favorites';
import { wildcardPool } from '../pools/wildcard';
import type { AlbumCandidate } from '../pools/types';
import { idbCache, kvGet, kvSet } from '../store/db';
import { Deck } from './deck';
import { loadSwipeState } from './history';

const SLIDER_KEY = 'settings.slider';
/** A pool's last build is reused for this long, so reloading the app doesn't re-roll (and re-query) it. */
const SNAPSHOT_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_SLIDER = 50;

export async function loadSlider(): Promise<number> {
  return (await kvGet<number>(SLIDER_KEY)) ?? DEFAULT_SLIDER;
}

export async function saveSlider(value: number): Promise<void> {
  await kvSet(SLIDER_KEY, value);
}

/**
 * The first call serves the pool's last build if it is recent enough; later calls (the deck
 * refilling a pool that ran low) always build fresh. Each fresh build replaces the snapshot.
 */
function snapshotted(id: string, build: () => Promise<AlbumCandidate[]>): () => Promise<AlbumCandidate[]> {
  const key = `pool:${id}`;
  let first = true;
  return async () => {
    if (first) {
      first = false;
      const cached = (await idbCache.get(key)) as AlbumCandidate[] | undefined;
      if (cached?.length) return cached;
    }
    const items = await build();
    await idbCache.set(key, items, SNAPSHOT_TTL_MS);
    return items;
  };
}

export async function createLiveDeck(onChange: () => void): Promise<Deck> {
  const [state, slider] = await Promise.all([loadSwipeState(), loadSlider()]);
  return new Deck({
    builders: {
      // Favorites come from cached library data and must see fresh play history, so no snapshot.
      favorites: () => favoritesPool(),
      adjacent: snapshotted('adjacent', () => adjacentPool({ count: 30 })),
      wildcard: snapshotted('wildcard', () => wildcardPool({ count: 20 })),
    },
    state,
    slider,
    onChange,
  });
}

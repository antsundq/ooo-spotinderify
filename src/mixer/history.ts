// Swipe history: the persistent log, per-artist weights and the in-memory view the deck reads.

import { db, type Swipe } from '../store/db';
import type { AlbumCandidate } from '../pools/types';
import { addToWeight, removeFromWeight, SWIPE_DELTA, type ArtistWeight, type LastSwipe, type SwipeDir } from './scoring';

export interface SwipeState {
  lastSwipe: Map<string, LastSwipe>;
  artistWeights: Map<string, ArtistWeight>;
}

export function emptySwipeState(): SwipeState {
  return { lastSwipe: new Map(), artistWeights: new Map() };
}

/** Applies a swipe to the in-memory state. Mirrors what `recordSwipe` persists. */
export function applySwipe(state: SwipeState, swipe: Swipe): void {
  state.lastSwipe.set(swipe.uri, { dir: swipe.dir, at: swipe.at });
  const delta = SWIPE_DELTA[swipe.dir];
  // "Not now" teaches nothing, so it leaves the artist weight untouched.
  if (delta) state.artistWeights.set(swipe.artistId, addToWeight(state.artistWeights.get(swipe.artistId), delta, swipe.at));
}

export async function loadSwipeState(): Promise<SwipeState> {
  const database = await db();
  const [swipes, keys, weights] = await Promise.all([
    database.getAll('swipes'),
    database.getAllKeys('artists'),
    database.getAll('artists'),
  ]);
  const state = emptySwipeState();
  // The log is in insertion order, so later swipes overwrite earlier ones.
  for (const s of swipes) state.lastSwipe.set(s.uri, { dir: s.dir, at: s.at });
  keys.forEach((k, i) => state.artistWeights.set(k, weights[i]!));
  return state;
}

export function makeSwipe(candidate: AlbumCandidate, dir: SwipeDir, now = Date.now()): Swipe {
  return {
    uri: candidate.uri,
    name: candidate.name,
    artist: candidate.artist,
    artistId: candidate.artistId,
    dir,
    at: now,
    source: candidate.source,
  };
}

/**
 * Persists a swipe: appends to the log, updates the artist weight and, for right swipes, the play history.
 * Returns the log ID, which `undoSwipe` takes.
 */
export async function recordSwipe(swipe: Swipe): Promise<number> {
  const tx = (await db()).transaction(['swipes', 'artists', 'plays'], 'readwrite');
  const { id: _ignored, ...entry } = swipe;
  const id = await tx.objectStore('swipes').add(entry);
  const artists = tx.objectStore('artists');
  const delta = SWIPE_DELTA[swipe.dir];
  if (delta) await artists.put(addToWeight(await artists.get(swipe.artistId), delta, swipe.at), swipe.artistId);
  if (swipe.dir === 'right') await tx.objectStore('plays').put(swipe.at, swipe.uri);
  await tx.done;
  return id;
}

/** Removes a swipe from the log and takes its contribution back out of the artist weight. */
export async function undoSwipe(id: number, now = Date.now()): Promise<Swipe | undefined> {
  const tx = (await db()).transaction(['swipes', 'artists'], 'readwrite');
  const swipe = await tx.objectStore('swipes').get(id);
  if (!swipe) return undefined;
  await tx.objectStore('swipes').delete(id);
  const artists = tx.objectStore('artists');
  const delta = SWIPE_DELTA[swipe.dir];
  if (delta) await artists.put(removeFromWeight(await artists.get(swipe.artistId), delta, swipe.at, now), swipe.artistId);
  await tx.done;
  return swipe;
}

/** Clears learned artist weights; the swipe log (and so anti-repeat) stays. */
export async function resetArtistWeights(): Promise<void> {
  await (await db()).clear('artists');
}

// Pure scoring rules for the mixer: pool weights, artist weights with decay, anti-repeat.

export type PoolId = 'favorites' | 'adjacent' | 'wildcard';
export const POOL_IDS: PoolId[] = ['favorites', 'adjacent', 'wildcard'];

export type PoolWeights = Record<PoolId, number>;

/** Discovery slider anchors (0 = old favorites, 100 = new discoveries). Values between are interpolated. */
const ANCHORS: [slider: number, weights: PoolWeights][] = [
  [0, { favorites: 0.8, adjacent: 0.2, wildcard: 0 }],
  [50, { favorites: 0.4, adjacent: 0.4, wildcard: 0.2 }],
  [100, { favorites: 0.1, adjacent: 0.5, wildcard: 0.4 }],
];

export function poolWeights(slider: number): PoolWeights {
  const x = Math.min(100, Math.max(0, slider));
  for (let i = 1; i < ANCHORS.length; i++) {
    const [x0, w0] = ANCHORS[i - 1]!;
    const [x1, w1] = ANCHORS[i]!;
    if (x <= x1) {
      if (x === x1) return { ...w1 };
      const t = (x - x0) / (x1 - x0);
      const lerp = (k: PoolId) => w0[k] + (w1[k] - w0[k]) * t;
      return { favorites: lerp('favorites'), adjacent: lerp('adjacent'), wildcard: lerp('wildcard') };
    }
  }
  return { ...ANCHORS[ANCHORS.length - 1]![1] };
}

// --- Swipes and artist weights -------------------------------------------------

/** right = play, up = save, left = skip (and learn), down = not now (no learning). */
export type SwipeDir = 'left' | 'right' | 'up' | 'down';

export const SWIPE_DELTA: Record<SwipeDir, number> = { right: 1, up: 1, left: -1, down: 0 };

const DAY = 24 * 60 * 60_000;

export const SCORING = {
  /** Artist weight halves every 30 days. */
  halfLifeMs: 30 * DAY,
  /** Artists whose decayed weight falls below this are suppressed (about two recent left swipes). */
  suppressBelow: -1.5,
  /** A left-swiped album is hidden this long. */
  leftHideMs: 90 * DAY,
  /** A right- or up-swiped album is hidden this long, so it does not bounce straight back. */
  otherHideMs: 14 * DAY,
  /** A "not now" (down) album comes back after this long, so it doesn't return in the same sitting. */
  laterHideMs: 2 * DAY,
};

/** Weight stored per artist: `value` as of `updatedAt`. Decays exponentially from there. */
export interface ArtistWeight {
  value: number;
  updatedAt: number;
}

export function decay(ageMs: number, halfLifeMs = SCORING.halfLifeMs): number {
  return 0.5 ** (Math.max(0, ageMs) / halfLifeMs);
}

export function currentWeight(w: ArtistWeight | undefined, now: number): number {
  return w ? w.value * decay(now - w.updatedAt) : 0;
}

/** Adds `delta` at time `now`. Folding decay in keeps one number per artist instead of a full history. */
export function addToWeight(w: ArtistWeight | undefined, delta: number, now: number): ArtistWeight {
  return { value: currentWeight(w, now) + delta, updatedAt: now };
}

/** Removes a past swipe's contribution exactly, for undo: it has decayed since `swipedAt` like everything else. */
export function removeFromWeight(w: ArtistWeight | undefined, delta: number, swipedAt: number, now: number): ArtistWeight {
  return { value: currentWeight(w, now) - delta * decay(now - swipedAt), updatedAt: now };
}

export function isSuppressed(weight: number): boolean {
  return weight < SCORING.suppressBelow;
}

/** Multiplier on an album's draw chance from its artist's weight: liked artists come up more. */
export function artistFactor(weight: number): number {
  return Math.min(3, Math.max(0.25, 1 + 0.25 * weight));
}

export interface LastSwipe {
  dir: SwipeDir;
  at: number;
}

export function isHiddenBySwipe(last: LastSwipe | undefined, now: number): boolean {
  if (!last) return false;
  const hide =
    last.dir === 'left' ? SCORING.leftHideMs : last.dir === 'down' ? SCORING.laterHideMs : SCORING.otherHideMs;
  return now - last.at < hide;
}

// --- Deck arrangement ----------------------------------------------------------

/** No more than this many cards in a row from the same artist. */
export const MAX_SAME_ARTIST_RUN = 2;

/** True if appending `artistId` after `queue` would make a run longer than allowed. */
export function wouldBreakArtistRun(queue: { artistId: string }[], artistId: string): boolean {
  if (queue.length < MAX_SAME_ARTIST_RUN) return false;
  return queue.slice(-MAX_SAME_ARTIST_RUN).every((c) => c.artistId === artistId);
}

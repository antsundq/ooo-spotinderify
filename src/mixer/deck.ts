// The deck: a lazily filled queue of ~15 cards drawn from the pools by slider weight.
// Pools build in the background; when one runs low it is rebuilt and the queue topped up.

import type { Swipe } from '../store/db';
import { normalizeName, normalizeTitle } from '../pools/resolve';
import type { AlbumCandidate } from '../pools/types';
import { weightedPick, type Rng } from '../pools/util';
import { applySwipe, type SwipeState } from './history';
import {
  artistFactor,
  currentWeight,
  isHiddenBySwipe,
  isSuppressed,
  MAX_SAME_ARTIST_RUN,
  POOL_IDS,
  poolWeights,
  wouldBreakArtistRun,
  type PoolId,
} from './scoring';

export const DECK_TARGET = 15;
/** Rebuild a pool when fewer than this many of its candidates are still eligible. */
const POOL_LOW = 5;
/** Don't rebuild the same pool more often than this. */
const REBUILD_COOLDOWN_MS = 60_000;
/** Draw from this many top-ranked eligible candidates of a pool, weighted by rank. */
const DRAW_WINDOW = 8;

export type DeckCard = AlbumCandidate & { pool: PoolId };

export interface PoolStatus {
  available: number;
  building: boolean;
  error?: string;
}

interface PoolState {
  items: AlbumCandidate[];
  building?: Promise<void>;
  builtAt: number;
  /** Set once the first build finished (or failed). */
  loaded?: boolean;
  error?: string;
}

export interface DeckDeps {
  builders: Record<PoolId, () => Promise<AlbumCandidate[]>>;
  state: SwipeState;
  slider: number;
  rng?: Rng;
  now?: () => number;
  /** Called whenever the queue or pool status changes. */
  onChange?: () => void;
}

function albumIdentity(c: Pick<AlbumCandidate, 'artist' | 'name'>): string {
  return `${normalizeName(c.artist)}|${normalizeTitle(c.name)}`;
}

export class Deck {
  private readonly pools = new Map<PoolId, PoolState>();
  private queue: DeckCard[] = [];
  /** Albums queued or shown this session, by URI and by normalized identity. */
  private readonly used = new Set<string>();
  /** Artists of the most recently removed cards, for the same-artist run rule. */
  private recentArtists: string[] = [];
  private state: SwipeState;
  private sliderValue: number;
  private readonly rng: Rng;
  private readonly now: () => number;

  constructor(private readonly deps: DeckDeps) {
    this.state = deps.state;
    this.sliderValue = deps.slider;
    this.rng = deps.rng ?? Math.random;
    this.now = deps.now ?? Date.now;
    for (const id of POOL_IDS) this.pools.set(id, { items: [], builtAt: 0 });
  }

  get cards(): readonly DeckCard[] {
    return this.queue;
  }

  get slider(): number {
    return this.sliderValue;
  }

  /**
   * Builds the pools one after another, favorites first (cheapest, mostly cached), so a cold start
   * doesn't fire every discovery request at once. Cards appear as soon as the first pool is ready.
   */
  async start(): Promise<void> {
    for (const id of POOL_IDS) await this.rebuild(id);
  }

  /** Changes the mix. Keeps the card on top so it doesn't vanish under the user's finger, redraws the rest. */
  setSlider(value: number): void {
    this.sliderValue = value;
    this.redraw(1);
    this.deps.onChange?.();
  }

  /** Keeps the first `keep` cards, puts the rest back in their pools and draws again with current weights. */
  private redraw(keep: number): void {
    const rest = this.queue.slice(keep);
    // Return in reverse so each pool keeps its original order at the front.
    for (const c of rest.reverse()) this.returnToPool(c);
    this.queue = this.queue.slice(0, keep);
    this.fill();
  }

  /** Call after a swipe has been recorded: removes the card, updates learned state, tops up. */
  swiped(swipe: Swipe): void {
    applySwipe(this.state, swipe);
    const card = this.queue.find((c) => c.uri === swipe.uri);
    this.queue = this.queue.filter((c) => c.uri !== swipe.uri);
    if (card) this.recentArtists = [...this.recentArtists, card.artistId].slice(-MAX_SAME_ARTIST_RUN);
    // A suppressed artist's other queued cards go too.
    for (const c of this.queue.filter((c) => !this.isEligible(c, false))) this.release(c);
    this.queue = this.queue.filter((c) => this.isEligible(c, false));
    this.fill();
    this.maybeRebuild();
    this.deps.onChange?.();
  }

  /** Puts a card back on top after an undo, with the swipe state reloaded from storage. */
  restore(card: DeckCard, state: SwipeState): void {
    this.state = state;
    this.queue = [card, ...this.queue.filter((c) => c.uri !== card.uri)];
    this.used.add(card.uri);
    while (this.queue.length > DECK_TARGET) this.returnToPool(this.queue.pop()!);
    this.recentArtists = this.recentArtists.slice(0, -1);
    this.deps.onChange?.();
  }

  /** Replaces the learned state (e.g. after resetting weights) and re-checks queued cards against it. */
  setState(state: SwipeState): void {
    this.state = state;
    for (const c of this.queue.filter((c) => !this.isEligible(c, false))) this.release(c);
    this.queue = this.queue.filter((c) => this.isEligible(c, false));
    this.fill();
    this.deps.onChange?.();
  }

  poolStatus(): Record<PoolId, PoolStatus> {
    const out = {} as Record<PoolId, PoolStatus>;
    for (const id of POOL_IDS) {
      const p = this.pools.get(id)!;
      out[id] = {
        available: p.items.filter((c) => this.isEligible(c, true)).length,
        building: !!p.building,
        error: p.error,
      };
    }
    return out;
  }

  // --- internals -----------------------------------------------------------

  private release(c: AlbumCandidate): void {
    this.used.delete(c.uri);
    this.used.delete(albumIdentity(c));
  }

  private returnToPool(card: DeckCard): void {
    this.release(card);
    const { pool: id, ...candidate } = card;
    this.pools.get(id)!.items.unshift(candidate);
  }

  private isEligible(c: AlbumCandidate, checkUsed: boolean): boolean {
    const now = this.now();
    if (checkUsed && (this.used.has(c.uri) || this.used.has(albumIdentity(c)))) return false;
    if (isHiddenBySwipe(this.state.lastSwipe.get(c.uri), now)) return false;
    return !isSuppressed(currentWeight(this.state.artistWeights.get(c.artistId), now));
  }

  private rebuild(id: PoolId): Promise<void> {
    const pool = this.pools.get(id)!;
    if (pool.building) return pool.building;
    pool.builtAt = this.now();
    pool.building = this.deps.builders[id]()
      .then((items) => {
        // Keep pool order (best first) and drop anything we already hold.
        const known = new Set(pool.items.map((c) => c.uri));
        pool.items = [...pool.items, ...items.filter((c) => !known.has(c.uri))];
        pool.error = undefined;
      })
      .catch((err: unknown) => {
        pool.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        pool.building = undefined;
        const firstLoad = !pool.loaded;
        pool.loaded = true;
        // Until a pool's first build lands, other pools fill its share. Re-mix once it arrives,
        // keeping the two visible cards (top and the one peeking behind it) in place.
        if (firstLoad) this.redraw(2);
        else this.fill();
        this.deps.onChange?.();
      });
    this.deps.onChange?.();
    return pool.building;
  }

  private maybeRebuild(): void {
    const now = this.now();
    for (const id of POOL_IDS) {
      const pool = this.pools.get(id)!;
      const eligible = pool.items.filter((c) => this.isEligible(c, true)).length;
      // First builds are start()'s job (one pool at a time); this only tops up pools that ran low.
      if (!pool.loaded) continue;
      if (eligible < POOL_LOW && !pool.building && now - pool.builtAt > REBUILD_COOLDOWN_MS) void this.rebuild(id);
    }
  }

  /** Draws cards until the queue holds DECK_TARGET or every pool is out of eligible candidates. */
  private fill(): void {
    const exhausted = new Set<PoolId>();
    while (this.queue.length < DECK_TARGET && exhausted.size < POOL_IDS.length) {
      const weights = poolWeights(this.sliderValue);
      const open = POOL_IDS.filter((id) => !exhausted.has(id));
      // Pools at weight 0 still serve as a fallback once the weighted ones are empty.
      const id = weightedPick(open, (p) => weights[p] || 1e-6, this.rng)!;
      const card = this.draw(id);
      if (!card) {
        exhausted.add(id);
        continue;
      }
      this.queue.push(card);
      this.used.add(card.uri);
      this.used.add(albumIdentity(card));
    }
    this.maybeRebuild();
  }

  private draw(id: PoolId): DeckCard | undefined {
    const pool = this.pools.get(id)!;
    const now = this.now();
    const runContext = [...this.recentArtists.map((artistId) => ({ artistId })), ...this.queue];
    const window: AlbumCandidate[] = [];
    for (const c of pool.items) {
      if (window.length >= DRAW_WINDOW) break;
      if (this.isEligible(c, true) && !wouldBreakArtistRun(runContext, c.artistId)) window.push(c);
    }
    const pick = weightedPick(
      window,
      (c) => (DRAW_WINDOW - window.indexOf(c)) * artistFactor(currentWeight(this.state.artistWeights.get(c.artistId), now)),
      this.rng,
    );
    if (!pick) return undefined;
    pool.items = pool.items.filter((c) => c !== pick);
    return { ...pick, pool: id };
  }
}

import { describe, expect, it, vi } from 'vitest';
import { Deck, DECK_TARGET, type DeckCard } from '../src/mixer/deck';
import { emptySwipeState, type SwipeState } from '../src/mixer/history';
import { addToWeight, POOL_IDS, type PoolId } from '../src/mixer/scoring';
import type { AlbumCandidate } from '../src/pools/types';
import type { Swipe } from '../src/store/db';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-10-17T12:00:00Z');

/** Deterministic PRNG so draws are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function candidates(pool: PoolId, n: number, artistOf = (i: number) => `${pool}-artist-${i}`): AlbumCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    uri: `spotify:album:${pool}-${i}`,
    name: `${pool} album ${i}`,
    artist: artistOf(i),
    artistId: artistOf(i),
    year: 2000,
    coverUrl: undefined,
    source: pool === 'favorites' ? { kind: 'favorite' } : { kind: 'tag', tag: 't' },
    score: n - i,
  }));
}

function makeDeck(opts: {
  slider?: number;
  state?: SwipeState;
  pools?: Partial<Record<PoolId, AlbumCandidate[]>>;
  now?: () => number;
  seed?: number;
}) {
  const builders = Object.fromEntries(
    POOL_IDS.map((id) => [id, vi.fn(async () => opts.pools?.[id] ?? candidates(id, 40))]),
  ) as unknown as Record<PoolId, ReturnType<typeof vi.fn<() => Promise<AlbumCandidate[]>>>>;
  const deck = new Deck({
    builders,
    state: opts.state ?? emptySwipeState(),
    slider: opts.slider ?? 50,
    rng: mulberry32(opts.seed ?? 1),
    now: opts.now ?? (() => NOW),
  });
  return { deck, builders };
}

function countByPool(cards: readonly DeckCard[]): Record<PoolId, number> {
  const out = { favorites: 0, adjacent: 0, wildcard: 0 };
  for (const c of cards) out[c.pool]++;
  return out;
}

function swipe(card: AlbumCandidate, dir: Swipe['dir'], at = NOW): Swipe {
  return { uri: card.uri, name: card.name, artist: card.artist, artistId: card.artistId, dir, at, source: card.source };
}

describe('Deck', () => {
  it('fills to the target once pools are built', async () => {
    const { deck } = makeDeck({});
    await deck.start();
    expect(deck.cards).toHaveLength(DECK_TARGET);
    expect(new Set(deck.cards.map((c) => c.uri)).size).toBe(DECK_TARGET);
  });

  it('follows the slider: favorites at 0, discovery at 100', async () => {
    const low = makeDeck({ slider: 0 });
    await low.deck.start();
    const lowMix = countByPool(low.deck.cards);
    expect(lowMix.wildcard).toBe(0);
    expect(lowMix.favorites).toBeGreaterThanOrEqual(9);

    const high = makeDeck({ slider: 100 });
    await high.deck.start();
    const highMix = countByPool(high.deck.cards);
    expect(highMix.favorites).toBeLessThanOrEqual(4);
    expect(highMix.adjacent + highMix.wildcard).toBeGreaterThanOrEqual(11);
  });

  it('reshuffles everything but the top card when the slider moves', async () => {
    const { deck } = makeDeck({ slider: 0 });
    await deck.start();
    const top = deck.cards[0];
    deck.setSlider(100);
    expect(deck.cards[0]).toBe(top);
    expect(deck.cards).toHaveLength(DECK_TARGET);
    expect(countByPool(deck.cards.slice(1)).favorites).toBeLessThanOrEqual(4);
  });

  it('does not lose cards when the slider moves back and forth', async () => {
    const pools = { favorites: candidates('favorites', 16), adjacent: candidates('adjacent', 3), wildcard: candidates('wildcard', 3) };
    const { deck } = makeDeck({ slider: 0, pools });
    await deck.start();
    deck.setSlider(100);
    deck.setSlider(0);
    const total = Object.values(deck.poolStatus()).reduce((n, p) => n + p.available, 0);
    expect(deck.cards.length + total).toBe(22);
  });

  it('never shows a recently left-swiped album, but brings it back after the window', async () => {
    const state = emptySwipeState();
    const fav = candidates('favorites', 3);
    state.lastSwipe.set(fav[0]!.uri, { dir: 'left', at: NOW - 10 * DAY });
    state.lastSwipe.set(fav[1]!.uri, { dir: 'left', at: NOW - 200 * DAY });
    const { deck } = makeDeck({ state, slider: 0, pools: { favorites: fav } });
    await deck.start();
    const uris = deck.cards.map((c) => c.uri);
    expect(uris).not.toContain(fav[0]!.uri);
    expect(uris).toContain(fav[1]!.uri);
  });

  it('suppresses artists whose weight fell below the threshold', async () => {
    const state = emptySwipeState();
    state.artistWeights.set('adjacent-artist-0', addToWeight(addToWeight(undefined, -1, NOW), -1, NOW));
    const { deck } = makeDeck({ state, slider: 100 });
    await deck.start();
    expect(deck.cards.map((c) => c.artistId)).not.toContain('adjacent-artist-0');
  });

  it('drops queued cards of an artist as soon as it gets suppressed', async () => {
    // Every adjacent album is by the same artist.
    const adjacent = candidates('adjacent', 20, () => 'same');
    const { deck } = makeDeck({ slider: 100, pools: { adjacent } });
    await deck.start();
    const card = deck.cards.find((c) => c.artistId === 'same')!;
    deck.swiped(swipe(card, 'left'));
    deck.swiped(swipe(deck.cards.find((c) => c.artistId === 'same')!, 'left'));
    expect(deck.cards.map((c) => c.artistId)).not.toContain('same');
  });

  it('never queues more than 2 cards in a row from the same artist', async () => {
    const favorites = candidates('favorites', 30, (i) => (i < 20 ? 'prolific' : `other-${i}`));
    for (let seed = 1; seed <= 20; seed++) {
      const { deck } = makeDeck({ slider: 0, pools: { favorites }, seed });
      await deck.start();
      const ids = deck.cards.map((c) => c.artistId);
      for (let i = 2; i < ids.length; i++) {
        expect(ids[i] === ids[i - 1] && ids[i] === ids[i - 2]).toBe(false);
      }
    }
  });

  it('applies the run rule across swiped cards too', async () => {
    const favorites = candidates('favorites', 30, (i) => (i % 2 === 0 ? 'x' : `y-${i}`));
    const { deck } = makeDeck({ slider: 0, pools: { favorites } });
    await deck.start();
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const top = deck.cards[0]!;
      seen.push(top.artistId);
      deck.swiped(swipe(top, 'right'));
    }
    for (let i = 2; i < seen.length; i++) {
      expect(seen[i] === seen[i - 1] && seen[i] === seen[i - 2]).toBe(false);
    }
  });

  it('refills after a swipe and rebuilds pools that run low', async () => {
    let now = NOW;
    const { deck, builders } = makeDeck({
      slider: 0,
      pools: { favorites: candidates('favorites', 18), adjacent: candidates('adjacent', 3), wildcard: candidates('wildcard', 3) },
      now: () => now,
    });
    await deck.start();
    expect(builders.favorites).toHaveBeenCalledTimes(1);
    now += 2 * 60_000;
    for (let i = 0; i < 6; i++) deck.swiped(swipe(deck.cards[0]!, 'left', now));
    expect(deck.cards.length).toBeGreaterThan(0);
    expect(builders.adjacent.mock.calls.length + builders.favorites.mock.calls.length).toBeGreaterThan(2);
  });

  it('restores a card on undo', async () => {
    const { deck } = makeDeck({});
    await deck.start();
    const top = deck.cards[0]!;
    deck.swiped(swipe(top, 'left'));
    expect(deck.cards[0]).not.toBe(top);
    deck.restore(top, emptySwipeState());
    expect(deck.cards[0]).toBe(top);
    expect(deck.cards).toHaveLength(DECK_TARGET);
  });

  it('reconsiders queued cards when the learned state is replaced', async () => {
    const adjacent = candidates('adjacent', 20, () => 'same');
    const { deck } = makeDeck({ slider: 100, pools: { adjacent } });
    await deck.start();
    expect(deck.cards.some((c) => c.artistId === 'same')).toBe(true);
    const state = emptySwipeState();
    state.artistWeights.set('same', addToWeight(undefined, -3, NOW));
    deck.setState(state);
    expect(deck.cards.some((c) => c.artistId === 'same')).toBe(false);
    expect(deck.cards).toHaveLength(DECK_TARGET);
  });

  it('re-mixes when slower discovery pools arrive after favorites', async () => {
    const builders = makeDeck({}).builders;
    let releaseAdjacent!: () => void;
    builders.adjacent.mockImplementation(
      () => new Promise((resolve) => (releaseAdjacent = () => resolve(candidates('adjacent', 40)))),
    );
    const deck = new Deck({ builders, state: emptySwipeState(), slider: 100, rng: mulberry32(5), now: () => NOW });
    const started = deck.start();
    await vi.waitFor(() => expect(deck.cards).toHaveLength(DECK_TARGET));
    // Only favorites so far, so they fill in.
    expect(countByPool(deck.cards).favorites).toBe(DECK_TARGET);
    const visible = deck.cards.slice(0, 2);
    releaseAdjacent();
    await started;
    expect(deck.cards.slice(0, 2)).toEqual(visible);
    expect(countByPool(deck.cards.slice(2)).favorites).toBeLessThanOrEqual(4);
  });

  it('keeps working when a pool fails', async () => {
    const builders = makeDeck({}).builders;
    builders.wildcard.mockRejectedValue(new Error('Last.fm down'));
    const deck = new Deck({ builders, state: emptySwipeState(), slider: 100, rng: mulberry32(3), now: () => NOW });
    await deck.start();
    expect(deck.cards).toHaveLength(DECK_TARGET);
    expect(deck.poolStatus().wildcard.error).toBe('Last.fm down');
  });
});

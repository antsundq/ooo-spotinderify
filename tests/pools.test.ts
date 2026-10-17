import { describe, expect, it } from 'vitest';
import type { SavedAlbum } from '../src/api/spotify';
import { toArray } from '../src/api/lastfm';
import { rankFavorites } from '../src/pools/favorites';
import { aggregateTags, EXPLORE_TAGS, pickTags } from '../src/pools/wildcard';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-10-17T00:00:00Z');

function saved(name: string, addedDaysAgo: number): SavedAlbum {
  return {
    added_at: new Date(NOW - addedDaysAgo * DAY).toISOString(),
    album: {
      id: name,
      uri: `spotify:album:${name}`,
      name,
      album_type: 'album',
      release_date: '2000',
      release_date_precision: 'year',
      total_tracks: 10,
      images: [],
      artists: [{ id: 'a', name: 'A', uri: 'spotify:artist:a' }],
    },
  };
}

describe('rankFavorites', () => {
  it('ranks longest-unheard first, falling back to save date', () => {
    const albums = [saved('recent-save', 5), saved('old-save', 400), saved('old-save-played-yesterday', 900)];
    const plays = new Map([['spotify:album:old-save-played-yesterday', NOW - DAY]]);
    const ranked = rankFavorites(albums, plays, NOW);
    expect(ranked.map((c) => c.name)).toEqual(['old-save', 'recent-save', 'old-save-played-yesterday']);
    expect(ranked[0]!.score).toBeCloseTo(400);
    expect(ranked.every((c) => c.source.kind === 'favorite')).toBe(true);
  });

  it('collapses deluxe duplicates in the library', () => {
    const ranked = rankFavorites([saved('Blue', 10), saved('Blue (Deluxe)', 20)], new Map(), NOW);
    expect(ranked.map((c) => c.name)).toEqual(['Blue']);
  });
});

describe('aggregateTags', () => {
  it('sums counts, drops junk and artist-name tags', () => {
    const tags = aggregateTags([
      { artist: 'Radiohead', tags: [{ name: 'Alternative', count: 100 }, { name: 'seen live', count: 90 }, { name: 'radiohead', count: 50 }] },
      { artist: 'Portishead', tags: [{ name: 'trip-hop', count: 100 }, { name: 'alternative', count: 40 }] },
    ]);
    expect(tags).toEqual([
      { tag: 'alternative', weight: 140 },
      { tag: 'trip-hop', weight: 100 },
    ]);
  });
});

describe('pickTags', () => {
  const mine = [
    { tag: 'indie', weight: 100 },
    { tag: 'jazz', weight: 50 },
  ];

  it('picks only my tags when exploreChance is 0', () => {
    const picked = pickTags(mine, 2, 0, Math.random);
    expect(picked.sort()).toEqual(['indie', 'jazz']);
  });

  it('explores only tags I have never touched when exploreChance is 1', () => {
    const picked = pickTags(mine, 3, 1, Math.random);
    expect(picked).toHaveLength(3);
    for (const t of picked) {
      expect(EXPLORE_TAGS).toContain(t);
      expect(t).not.toBe('jazz');
    }
  });

  it('explores when I have no tags yet', () => {
    expect(pickTags([], 2, 0, Math.random)).toHaveLength(2);
  });
});

describe('toArray', () => {
  it('normalizes Last.fm single-item quirks', () => {
    expect(toArray(undefined)).toEqual([]);
    expect(toArray({ a: 1 })).toEqual([{ a: 1 }]);
    expect(toArray([1, 2])).toEqual([1, 2]);
  });
});

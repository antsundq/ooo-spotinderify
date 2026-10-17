import { describe, expect, it } from 'vitest';
import {
  addToWeight,
  artistFactor,
  currentWeight,
  decay,
  isHiddenBySwipe,
  isSuppressed,
  poolWeights,
  removeFromWeight,
  SCORING,
  wouldBreakArtistRun,
} from '../src/mixer/scoring';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-10-17T12:00:00Z');

describe('poolWeights', () => {
  it('hits the anchors from the plan', () => {
    expect(poolWeights(0)).toEqual({ favorites: 0.8, adjacent: 0.2, wildcard: 0 });
    expect(poolWeights(50)).toEqual({ favorites: 0.4, adjacent: 0.4, wildcard: 0.2 });
    expect(poolWeights(100)).toEqual({ favorites: 0.1, adjacent: 0.5, wildcard: 0.4 });
  });

  it('interpolates between anchors and always sums to 1', () => {
    const w = poolWeights(25);
    expect(w.favorites).toBeCloseTo(0.6);
    expect(w.adjacent).toBeCloseTo(0.3);
    expect(w.wildcard).toBeCloseTo(0.1);
    for (let x = 0; x <= 100; x += 5) {
      const v = poolWeights(x);
      expect(v.favorites + v.adjacent + v.wildcard).toBeCloseTo(1);
    }
  });

  it('shifts monotonically from favorites to discovery', () => {
    for (let x = 5; x <= 100; x += 5) {
      expect(poolWeights(x).favorites).toBeLessThanOrEqual(poolWeights(x - 5).favorites);
    }
  });

  it('clamps out-of-range values', () => {
    expect(poolWeights(-10)).toEqual(poolWeights(0));
    expect(poolWeights(150)).toEqual(poolWeights(100));
  });
});

describe('artist weights', () => {
  it('halves every 30 days', () => {
    expect(decay(0)).toBe(1);
    expect(decay(30 * DAY)).toBeCloseTo(0.5);
    expect(decay(60 * DAY)).toBeCloseTo(0.25);
  });

  it('adds +1/-1 on top of the decayed value', () => {
    let w = addToWeight(undefined, 1, NOW);
    expect(currentWeight(w, NOW)).toBe(1);
    w = addToWeight(w, 1, NOW + 30 * DAY);
    expect(currentWeight(w, NOW + 30 * DAY)).toBeCloseTo(1.5);
    expect(currentWeight(w, NOW + 60 * DAY)).toBeCloseTo(0.75);
  });

  it('undo removes exactly what the swipe added, decayed to now', () => {
    const before = addToWeight(undefined, 1, NOW - 10 * DAY);
    const after = addToWeight(before, -1, NOW - 5 * DAY);
    const undone = removeFromWeight(after, -1, NOW - 5 * DAY, NOW);
    expect(currentWeight(undone, NOW)).toBeCloseTo(currentWeight(before, NOW));
  });

  it('suppresses after two recent left swipes, and forgives over time', () => {
    let w = addToWeight(undefined, -1, NOW);
    expect(isSuppressed(currentWeight(w, NOW))).toBe(false);
    w = addToWeight(w, -1, NOW);
    expect(isSuppressed(currentWeight(w, NOW))).toBe(true);
    expect(isSuppressed(currentWeight(w, NOW + 20 * DAY))).toBe(false);
  });

  it('boosts liked artists and damps disliked ones, within bounds', () => {
    expect(artistFactor(0)).toBe(1);
    expect(artistFactor(2)).toBeGreaterThan(1);
    expect(artistFactor(-1)).toBeLessThan(1);
    expect(artistFactor(100)).toBe(3);
    expect(artistFactor(-100)).toBe(0.25);
  });
});

describe('anti-repeat', () => {
  it('hides a left-swiped album for the left window', () => {
    const left = { dir: 'left' as const, at: NOW };
    expect(isHiddenBySwipe(left, NOW + SCORING.leftHideMs - DAY)).toBe(true);
    expect(isHiddenBySwipe(left, NOW + SCORING.leftHideMs + DAY)).toBe(false);
  });

  it('hides right/up swipes for a shorter window', () => {
    const right = { dir: 'right' as const, at: NOW };
    expect(isHiddenBySwipe(right, NOW + SCORING.otherHideMs - DAY)).toBe(true);
    expect(isHiddenBySwipe(right, NOW + SCORING.otherHideMs + DAY)).toBe(false);
    expect(SCORING.otherHideMs).toBeLessThan(SCORING.leftHideMs);
  });

  it('never hides unswiped albums', () => {
    expect(isHiddenBySwipe(undefined, NOW)).toBe(false);
  });

  it('flags a third card in a row from the same artist', () => {
    const a = { artistId: 'a' };
    const b = { artistId: 'b' };
    expect(wouldBreakArtistRun([], 'a')).toBe(false);
    expect(wouldBreakArtistRun([a], 'a')).toBe(false);
    expect(wouldBreakArtistRun([a, a], 'a')).toBe(true);
    expect(wouldBreakArtistRun([a, b], 'a')).toBe(false);
    expect(wouldBreakArtistRun([a, a], 'b')).toBe(false);
  });
});

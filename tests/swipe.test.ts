import { describe, expect, it } from 'vitest';
import { formatDuration } from '../src/ui/card';
import { decideSwipe } from '../src/ui/swipe';

const W = 360;
const H = 456;

describe('decideSwipe', () => {
  it('commits on distance', () => {
    expect(decideSwipe(W * 0.35, 10, 0, 0, W, H)).toBe('right');
    expect(decideSwipe(-W * 0.35, 10, 0, 0, W, H)).toBe('left');
    expect(decideSwipe(5, -H * 0.35, 0, 0, W, H)).toBe('up');
  });

  it('commits on a fast flick even if short', () => {
    expect(decideSwipe(40, 0, 0.9, 0, W, H)).toBe('right');
    expect(decideSwipe(-40, 0, -0.9, 0, W, H)).toBe('left');
    expect(decideSwipe(0, -40, 0, -0.9, W, H)).toBe('up');
  });

  it('snaps back on short, slow drags', () => {
    expect(decideSwipe(W * 0.2, 0, 0.1, 0, W, H)).toBeUndefined();
    expect(decideSwipe(0, -H * 0.2, 0, -0.1, W, H)).toBeUndefined();
  });

  it('ignores a fast but tiny flick', () => {
    expect(decideSwipe(10, 0, 2, 0, W, H)).toBeUndefined();
  });

  it('does not swipe down', () => {
    expect(decideSwipe(0, H * 0.6, 0, 2, W, H)).toBeUndefined();
  });

  it('uses the dominant axis', () => {
    expect(decideSwipe(W * 0.35, -H * 0.5, 0, 0, W, H)).toBe('up');
    expect(decideSwipe(W * 0.5, -H * 0.35, 0, 0, W, H)).toBe('right');
  });

  it('does not commit against the drag direction', () => {
    // Fast leftward flick at the end of a drag that is still right of centre.
    expect(decideSwipe(40, 0, -1, 0, W, H)).toBeUndefined();
  });
});

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(42 * 60_000)).toBe('42 min');
    expect(formatDuration(75 * 60_000)).toBe('1 h 15 min');
  });
});

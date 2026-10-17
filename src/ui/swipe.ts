// Pointer-driven swipe gestures: drag with rotation, fling on release, tap to flip.
// Only transform and opacity change during a drag, and DOM writes are batched per frame,
// so the browser can keep the card on the compositor at 60 fps.

import type { SwipeDir } from '../mixer/scoring';

/** Fraction of the card's width (or height, for up) to drag before release commits the swipe. */
const DISTANCE_COMMIT = 0.3;
/** Release speed (px/ms) that commits a swipe even when the drag was short. */
const VELOCITY_COMMIT = 0.5;
/** Minimum drag before a fast flick counts, so a quick tap never becomes a swipe. */
const MIN_FLICK_PX = 30;
const TAP_MAX_PX = 8;
const TAP_MAX_MS = 350;
const ROTATE_DEG_PER_PX = 0.06;
const FLING_MS = 260;
const SNAP_BACK_MS = 280;

export interface SwipeHandlers {
  /** A gesture committed to a direction. The fling animation has already started. */
  onSwipe(dir: SwipeDir): void;
  onTap(): void;
  /** Return false to let the pointer interact natively, e.g. scrolling the tracklist. */
  canStart?(target: EventTarget | null): boolean;
}

export interface SwipeController {
  /** Animates the card off-screen in `dir`. Resolves when it is gone. */
  fling(dir: SwipeDir): Promise<void>;
  destroy(): void;
}

interface Sample {
  x: number;
  y: number;
  t: number;
}

export function decideSwipe(
  dx: number,
  dy: number,
  vx: number,
  vy: number,
  width: number,
  height: number,
): SwipeDir | undefined {
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  if (horizontal) {
    if (dx > width * DISTANCE_COMMIT || (vx > VELOCITY_COMMIT && dx > MIN_FLICK_PX)) return 'right';
    if (dx < -width * DISTANCE_COMMIT || (vx < -VELOCITY_COMMIT && dx < -MIN_FLICK_PX)) return 'left';
  } else if (dy < -height * DISTANCE_COMMIT || (vy < -VELOCITY_COMMIT && dy < -MIN_FLICK_PX)) {
    return 'up';
  }
  return undefined;
}

function setStamps(el: HTMLElement, dx: number, dy: number, width: number, height: number): void {
  const w = width * DISTANCE_COMMIT;
  const h = height * DISTANCE_COMMIT;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  el.style.setProperty('--stamp-right', horizontal ? String(Math.min(1, Math.max(0, dx / w))) : '0');
  el.style.setProperty('--stamp-left', horizontal ? String(Math.min(1, Math.max(0, -dx / w))) : '0');
  el.style.setProperty('--stamp-up', horizontal ? '0' : String(Math.min(1, Math.max(0, -dy / h))));
}

export function attachSwipe(el: HTMLElement, handlers: SwipeHandlers): SwipeController {
  let pointerId: number | undefined;
  let start: Sample | undefined;
  let samples: Sample[] = [];
  let dx = 0;
  let dy = 0;
  let frame = 0;
  let gone = false;
  // Measured once per gesture so a drag frame never forces layout.
  let width = 1;
  let height = 1;

  const paint = () => {
    frame = 0;
    el.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${dx * ROTATE_DEG_PER_PX}deg)`;
    setStamps(el, dx, dy, width, height);
  };

  const fling = (dir: SwipeDir, vx = 0, vy = 0): Promise<void> => {
    gone = true;
    el.classList.add('leaving');
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Keep some of the release motion so the throw follows the finger.
    const tx = dir === 'right' ? w + width : dir === 'left' ? -(w + width) : dx + vx * 150;
    const ty = dir === 'up' ? -(h + height) : dy + vy * 150;
    const rot = dir === 'up' ? dx * ROTATE_DEG_PER_PX : (dir === 'right' ? 1 : -1) * 24;
    setStamps(el, dir === 'right' ? 1e6 : dir === 'left' ? -1e6 : 0, dir === 'up' ? -1e6 : 0, 1, 1);
    el.style.transition = `transform ${FLING_MS}ms cubic-bezier(.3,.6,.4,1)`;
    el.style.transform = `translate3d(${tx}px, ${ty}px, 0) rotate(${rot}deg)`;
    return new Promise((resolve) => setTimeout(resolve, FLING_MS));
  };

  const onDown = (e: PointerEvent) => {
    if (gone || pointerId !== undefined || e.button !== 0) return;
    if (handlers.canStart && !handlers.canStart(e.target)) return;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone (or synthetic); track it without capture rather than get stuck.
    }
    pointerId = e.pointerId;
    start = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    samples = [start];
    dx = dy = 0;
    width = el.offsetWidth;
    height = el.offsetHeight;
    el.style.transition = 'none';
    el.classList.add('dragging');
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId || !start) return;
    dx = e.clientX - start.x;
    dy = e.clientY - start.y;
    samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (samples.length > 8) samples.shift();
    if (!frame) frame = requestAnimationFrame(paint);
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId || !start) return;
    pointerId = undefined;
    el.classList.remove('dragging');
    if (frame) cancelAnimationFrame(frame);
    frame = 0;

    // Velocity over the last ~100 ms of movement.
    const last = samples[samples.length - 1]!;
    const first = samples.find((s) => last.t - s.t <= 100) ?? samples[0]!;
    const dt = Math.max(1, last.t - first.t);
    const vx = (last.x - first.x) / dt;
    const vy = (last.y - first.y) / dt;

    const moved = Math.hypot(dx, dy);
    if (e.type === 'pointerup' && moved < TAP_MAX_PX && e.timeStamp - start.t < TAP_MAX_MS) {
      el.style.transform = '';
      handlers.onTap();
      return;
    }
    const dir = e.type === 'pointerup' ? decideSwipe(dx, dy, vx, vy, width, height) : undefined;
    if (dir) {
      void fling(dir, vx, vy);
      handlers.onSwipe(dir);
    } else {
      el.style.transition = `transform ${SNAP_BACK_MS}ms cubic-bezier(.2,.9,.3,1.2)`;
      el.style.transform = '';
      setStamps(el, 0, 0, width, height);
    }
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);

  return {
    fling: (dir) => {
      width = el.offsetWidth;
      height = el.offsetHeight;
      return fling(dir);
    },
    destroy() {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    },
  };
}

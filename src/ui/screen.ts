// The main swipe screen: top bar (undo, discovery slider, menu), card stack, action buttons.

import { removeFromLibrary, saveToLibrary } from '../api/spotify';
import type { Deck, DeckCard } from '../mixer/deck';
import { loadSwipeState, makeSwipe, recordSwipe, undoSwipe } from '../mixer/history';
import { createLiveDeck, saveSlider } from '../mixer/live';
import { POOL_IDS, type SwipeDir } from '../mixer/scoring';
import type { Swipe } from '../store/db';
import { createCardElement, escapeHtml, preloadCovers, toggleFlip } from './card';
import { playAlbum, renderNowPlaying, showDevicePicker } from './player';
import { attachSwipe, type SwipeController } from './swipe';

const ICONS = {
  undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  skip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M8 5.5v13l10.5-6.5z"/></svg>',
};

const UNDO_LIMIT = 20;

interface UndoEntry {
  card: DeckCard;
  swipe: Swipe;
  saved: Promise<number>;
}

interface CardEntry {
  el: HTMLElement;
  ctl?: SwipeController;
  leaving?: boolean;
}

export interface ScreenOptions {
  displayName: string;
  onLogout: () => void;
}

export async function mountDeckScreen(root: HTMLElement, opts: ScreenOptions): Promise<() => void> {
  root.innerHTML = `
    <div class="screen">
      <header class="topbar">
        <button class="icon-btn" data-undo aria-label="Undo last swipe" disabled>${ICONS.undo}</button>
        <label class="mix">
          <span>Favorites</span>
          <input type="range" min="0" max="100" step="1" data-slider aria-label="Discovery mix">
          <span>New</span>
        </label>
        <button class="icon-btn" data-menu aria-label="Menu">${ICONS.menu}</button>
      </header>
      <main class="stack" data-stack>
        <div class="empty" data-empty><div class="spinner"></div><p>Building your deck…</p></div>
      </main>
      <div class="nowplaying" data-now hidden></div>
      <footer class="actions">
        <button class="round skip" data-act="left" aria-label="Skip">${ICONS.skip}</button>
        <button class="round save" data-act="up" aria-label="Save to library">${ICONS.save}</button>
        <button class="round play" data-act="right" aria-label="Play album">${ICONS.play}</button>
      </footer>
      <div class="toast" data-toast role="status" aria-live="polite"></div>
      <dialog class="sheet" data-sheet>
        <p>Logged in as <strong>${escapeHtml(opts.displayName)}</strong></p>
        <a class="sheet-link" href="#/debug">Debug</a>
        <button class="secondary" data-logout>Log out</button>
        <button data-close>Close</button>
      </dialog>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const stack = $('[data-stack]');
  const empty = $('[data-empty]');
  const slider = $<HTMLInputElement>('[data-slider]');
  const undoButton = $<HTMLButtonElement>('[data-undo]');
  const toast = $('[data-toast]');
  const sheet = $<HTMLDialogElement>('[data-sheet]');
  const nowBar = $('[data-now]');

  const entries = new Map<string, CardEntry>();
  const undoStack: UndoEntry[] = [];
  /** Direction a card left in, so an undo can bring it back from the same side. */
  const returning = new Map<string, SwipeDir>();
  let toastTimer = 0;

  const showToast = (message: string) => {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2800);
  };

  let deck: Deck;
  const render = () => {
    const want = deck.cards.slice(0, 2);
    for (const [uri, entry] of entries) {
      if (!entry.leaving && !want.some((c) => c.uri === uri)) {
        entry.ctl?.destroy();
        entry.el.remove();
        entries.delete(uri);
      }
    }
    want.forEach((card, i) => {
      let entry = entries.get(card.uri);
      if (!entry || entry.leaving) {
        entry = { el: createCardElement(card) };
        entries.set(card.uri, entry);
        stack.append(entry.el);
        const from = returning.get(card.uri);
        if (from) {
          returning.delete(card.uri);
          flyIn(entry.el, from);
        }
      }
      entry.el.classList.toggle('top', i === 0);
      entry.el.classList.toggle('next', i === 1);
      if (i === 0 && !entry.ctl) entry.ctl = attachSwipe(entry.el, swipeHandlers(card, entry));
      if (i !== 0 && entry.ctl) {
        entry.ctl.destroy();
        entry.ctl = undefined;
      }
    });
    empty.hidden = want.length > 0;
    if (!want.length) {
      const errors = Object.values(deck.poolStatus()).filter((p) => p.error);
      const building = Object.values(deck.poolStatus()).some((p) => p.building);
      empty.querySelector('p')!.textContent = building
        ? 'Building your deck…'
        : errors.length === POOL_IDS.length
          ? `Couldn't build a deck: ${errors[0]!.error}`
          : 'Out of albums for now. Try moving the slider.';
      empty.querySelector('.spinner')!.toggleAttribute('hidden', !building);
    }
    preloadCovers(deck.cards.slice(2, 6));
    undoButton.disabled = undoStack.length === 0;
  };

  const swipeHandlers = (card: DeckCard, entry: CardEntry) => ({
    onSwipe: (dir: SwipeDir) => commit(card, entry, dir),
    onTap: () => toggleFlip(entry.el),
  });

  const commit = (card: DeckCard, entry: CardEntry, dir: SwipeDir) => {
    entry.leaving = true;
    entry.ctl?.destroy();
    entry.ctl = undefined;
    setTimeout(() => {
      entry.el.remove();
      if (entries.get(card.uri) === entry) entries.delete(card.uri);
    }, 300);

    const swipe = makeSwipe(card, dir);
    const saved = recordSwipe(swipe);
    saved.catch((err: unknown) => showToast(`Couldn't save swipe: ${errorText(err)}`));
    undoStack.push({ card, swipe, saved });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    deck.swiped(swipe);

    if (dir === 'up') {
      saveToLibrary([card.uri]).then(
        () => showToast(`Saved “${card.name}” to your library`),
        (err: unknown) => showToast(`Couldn't save: ${errorText(err)}`),
      );
    } else if (dir === 'right') {
      void playAlbum(card, { pickDevice: (devices) => showDevicePicker(root, devices) }).then((r) => {
        showToast(r.message);
        if (r.ok && r.device) renderNowPlaying(nowBar, card, r.device);
      });
    }
  };

  /** Button and keyboard swipes: animate the top card out, then commit. */
  const act = (dir: SwipeDir) => {
    const card = deck.cards[0];
    const entry = card && entries.get(card.uri);
    if (!card || !entry?.ctl || entry.leaving) return;
    void entry.ctl.fling(dir);
    commit(card, entry, dir);
  };

  const undo = async () => {
    const last = undoStack.pop();
    if (!last) return;
    undoButton.disabled = undoStack.length === 0;
    try {
      await undoSwipe(await last.saved);
      if (last.swipe.dir === 'up') await removeFromLibrary([last.card.uri]);
    } catch (err) {
      showToast(`Undo failed: ${errorText(err)}`);
    }
    returning.set(last.card.uri, last.swipe.dir);
    deck.restore(last.card, await loadSwipeState());
  };

  try {
    deck = await createLiveDeck(() => render());
  } catch (err) {
    empty.querySelector('p')!.textContent = errorText(err);
    return () => {};
  }
  slider.value = String(deck.slider);
  render();
  void deck.start();

  // Slider: redraw the deck at most once per frame while dragging, persist on release.
  let sliderFrame = 0;
  slider.addEventListener('input', () => {
    if (sliderFrame) return;
    sliderFrame = requestAnimationFrame(() => {
      sliderFrame = 0;
      deck.setSlider(Number(slider.value));
    });
  });
  slider.addEventListener('change', () => void saveSlider(Number(slider.value)));

  root.querySelector('.actions')!.addEventListener('click', (e) => {
    const dir = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act as SwipeDir | undefined;
    if (dir) act(dir);
  });
  undoButton.addEventListener('click', () => void undo());
  $('[data-menu]').addEventListener('click', () => sheet.showModal());
  $('[data-close]').addEventListener('click', () => sheet.close());
  sheet.addEventListener('click', (e) => e.target === sheet && sheet.close());
  sheet.querySelector('a')!.addEventListener('click', () => sheet.close());
  $('[data-logout]').addEventListener('click', () => {
    sheet.close();
    opts.onLogout();
  });

  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (sheet.open || document.querySelector('dialog[open]') || target.closest('input')) return;
    // Let Enter/Space activate a focused button or link instead of flipping.
    if ((e.key === ' ' || e.key === 'Enter') && target.closest('button, a')) return;
    const keyDir: Record<string, SwipeDir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up' };
    if (keyDir[e.key]) {
      e.preventDefault();
      act(keyDir[e.key]!);
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      const top = deck.cards[0] && entries.get(deck.cards[0].uri);
      if (top && !top.leaving) toggleFlip(top.el);
    } else if (e.key === 'z' || e.key === 'Backspace') {
      void undo();
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

/** Starts a restored card off-screen on the side it left, then lets it slide back in. */
function flyIn(el: HTMLElement, from: SwipeDir): void {
  const offset = { left: 'translate3d(-120vw, 0, 0) rotate(-24deg)', right: 'translate3d(120vw, 0, 0) rotate(24deg)', up: 'translate3d(0, -120vh, 0)' };
  el.style.transition = 'none';
  el.style.transform = offset[from];
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      el.style.transition = 'transform 320ms cubic-bezier(.2,.8,.3,1)';
      el.style.transform = '';
    }),
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

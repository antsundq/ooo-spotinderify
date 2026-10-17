// Settings dialog: slider presets, exclusions, reset learned weights, clear cache.

import type { Deck } from '../mixer/deck';
import { loadSwipeState, resetArtistWeights } from '../mixer/history';
import { saveSlider } from '../mixer/live';
import { loadExclusions, saveExclusions } from '../pools/filters';
import { clearCache } from '../store/db';
import { escapeHtml } from './card';

export const SLIDER_PRESETS: { label: string; value: number }[] = [
  { label: 'Old favorites', value: 0 },
  { label: 'Mostly favorites', value: 25 },
  { label: 'Balanced', value: 50 },
  { label: 'Mostly new', value: 75 },
  { label: 'All new', value: 100 },
];

export interface SettingsHooks {
  deck: Deck;
  /** Called after the slider moved, so the top bar can follow. */
  onSlider: (value: number) => void;
  toast: (message: string) => void;
  /** Rebuild the deck from scratch, after changes that affect how pools are built. */
  reload: () => void;
}

export async function showSettings(host: HTMLElement, hooks: SettingsHooks): Promise<void> {
  const exclusions = await loadExclusions();
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet settings';
  dialog.innerHTML = `
    <h2>Settings</h2>

    <section>
      <h3>Discovery mix</h3>
      <div class="presets">
        ${SLIDER_PRESETS.map(
          (p) => `<button class="secondary${hooks.deck.slider === p.value ? ' selected' : ''}" data-preset="${p.value}">${p.label}</button>`,
        ).join('')}
      </div>
    </section>

    <section>
      <h3>Exclude</h3>
      <label>Artists, one per line
        <textarea rows="3" data-artists placeholder="Arne Alligator & Djungeltrumman">${escapeHtml(exclusions.artists.join('\n'))}</textarea>
      </label>
      <label>Genres, one per line
        <textarea rows="3" data-genres placeholder="death metal">${escapeHtml(exclusions.genres.join('\n'))}</textarea>
      </label>
      <p class="muted small">Genres use Last.fm tags and apply to new discoveries; artists apply everywhere.
        Excluding “metal” also excludes “death metal”.</p>
      <button data-save-exclusions>Save exclusions</button>
    </section>

    <section>
      <h3>Learning</h3>
      <button class="secondary" data-reset-weights>Reset learned artist weights</button>
      <button class="secondary" data-clear-cache>Clear cached Spotify data</button>
      <p class="muted small">Clearing the cache refetches your library and rebuilds the pools, which uses Spotify quota.
        Swipe history and Last.fm→Spotify matches are kept.</p>
    </section>

    <button data-close>Done</button>`;
  host.append(dialog);
  dialog.showModal();

  dialog.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t === dialog || t.closest('[data-close]')) return dialog.close();

    const preset = t.closest<HTMLElement>('[data-preset]');
    if (preset) {
      const value = Number(preset.dataset.preset);
      hooks.deck.setSlider(value);
      hooks.onSlider(value);
      await saveSlider(value);
      dialog.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('selected', b === preset));
      return;
    }

    if (t.closest('[data-save-exclusions]')) {
      const lines = (sel: string) => dialog.querySelector<HTMLTextAreaElement>(sel)!.value.split('\n');
      await saveExclusions({ artists: lines('[data-artists]'), genres: lines('[data-genres]') });
      // Pools filter at build time, so rebuild them without their snapshots.
      await clearCache();
      dialog.close();
      hooks.toast('Exclusions saved. Rebuilding your deck…');
      hooks.reload();
      return;
    }

    if (t.closest('[data-reset-weights]')) {
      await resetArtistWeights();
      hooks.deck.setState(await loadSwipeState());
      hooks.toast('Learned artist weights reset');
      return;
    }

    if (t.closest('[data-clear-cache]')) {
      await clearCache();
      dialog.close();
      hooks.toast('Cache cleared. Rebuilding your deck…');
      hooks.reload();
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
}

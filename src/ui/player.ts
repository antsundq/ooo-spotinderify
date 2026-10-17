// Playback on right swipe. Phase 5 replaces this with device selection and `PUT /me/player/play`.

import type { DeckCard } from '../mixer/deck';

export interface PlayResult {
  ok: boolean;
  message: string;
}

export async function playAlbum(card: DeckCard): Promise<PlayResult> {
  return { ok: true, message: `Liked “${card.name}”. Playback arrives in Phase 5.` };
}

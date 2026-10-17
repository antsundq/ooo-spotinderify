// Favorites pool: albums already in my library, longest-unheard first.

import { getRecentlyPlayed, getSavedAlbums, spotify, type SavedAlbum, type SpotifyClient } from '../api/spotify';
import { getLastPlayed, recordPlays } from '../store/db';
import { dedupeAlbums, toCandidate } from './resolve';
import type { AlbumCandidate } from './types';

const DAY = 24 * 60 * 60_000;

/**
 * Scores saved albums by days since last heard. Albums I have no play record for
 * count from when I saved them, so old never-revisited saves rise to the top.
 */
export function rankFavorites(saved: SavedAlbum[], lastPlayed: Map<string, number>, now: number): AlbumCandidate[] {
  const addedAt = new Map(saved.map((s) => [s.album.uri, Date.parse(s.added_at)]));
  return dedupeAlbums(saved.map((s) => s.album))
    .map((album) => {
      const heard = lastPlayed.get(album.uri) ?? addedAt.get(album.uri) ?? now;
      return toCandidate(album, { kind: 'favorite' }, Math.max(0, (now - heard) / DAY));
    })
    .sort((a, b) => b.score - a.score);
}

export async function favoritesPool({ client = spotify, now = Date.now() }: { client?: SpotifyClient; now?: number } = {}) {
  const [saved, recent] = await Promise.all([getSavedAlbums(client), getRecentlyPlayed(client)]);
  // Spotify only remembers the last 50 plays, so keep our own running history.
  await recordPlays(recent.map((p) => [p.track.album.uri, Date.parse(p.played_at)]));
  return rankFavorites(saved, await getLastPlayed(), now);
}

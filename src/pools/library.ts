import {
  getSavedAlbums,
  getTopArtists,
  QuotaExceededError,
  spotify,
  type SimplifiedAlbum,
  type SpotifyArtist,
  type SpotifyClient,
} from '../api/spotify';
import { LastfmError } from '../api/lastfm';
import { albumKeyOf } from './resolve';

/** Answers "is this album (in any edition) already in my library?". */
export interface Library {
  has(album: Pick<SimplifiedAlbum, 'uri' | 'name' | 'artists'>): boolean;
}

export async function loadLibrary(client: SpotifyClient = spotify): Promise<Library> {
  const saved = await getSavedAlbums(client);
  const uris = new Set(saved.map((s) => s.album.uri));
  const keys = new Set(saved.map((s) => albumKeyOf(s.album)));
  return { has: (a) => uris.has(a.uri) || keys.has(albumKeyOf(a)) };
}

/** Medium- and long-term top artists, deduped, medium-term first. */
export async function loadTopArtists(client: SpotifyClient = spotify): Promise<SpotifyArtist[]> {
  const [medium, long] = await Promise.all([getTopArtists('medium_term', client), getTopArtists('long_term', client)]);
  const seen = new Set<string>();
  return [...medium, ...long].filter((a) => !seen.has(a.id) && !!seen.add(a.id));
}

/** Errors that should abort a whole pool build instead of skipping one item: quota, or a missing/invalid Last.fm key. */
export const isFatal = (e: unknown) =>
  e instanceof QuotaExceededError || (e instanceof LastfmError && e.code === 10);

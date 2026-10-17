// Adjacent pool: albums by artists similar to my top artists (via Last.fm), not in my library.

import { lastfm, type LastfmClient } from '../api/lastfm';
import { getArtistAlbums, spotify, type SpotifyClient } from '../api/spotify';
import { isFatal, loadLibrary, loadTopArtists } from './library';
import { dedupeAlbums, isProperAlbum, normalizeName, resolveArtist, toCandidate } from './resolve';
import type { AlbumCandidate } from './types';
import { mapLimit, shuffle, tryOrSkip, weightedPick, type Rng } from './util';

export interface AdjacentOptions {
  count?: number;
  /** How many of my top artists to ask Last.fm about per build. */
  seeds?: number;
  albumsPerArtist?: number;
  rng?: Rng;
  client?: SpotifyClient;
  lfm?: LastfmClient;
}

interface SimilarPick {
  name: string;
  match: number;
  seed: string;
}

export async function adjacentPool({
  count = 20,
  seeds = 8,
  albumsPerArtist = 2,
  rng = Math.random,
  client = spotify,
  lfm = lastfm,
}: AdjacentOptions = {}): Promise<AlbumCandidate[]> {
  const [top, library] = await Promise.all([loadTopArtists(client), loadLibrary(client)]);
  const topNames = new Set(top.map((a) => normalizeName(a.name)));

  // Similar artists for a random handful of my top artists. Keep the best match per artist.
  const seedArtists = shuffle(top, rng).slice(0, seeds);
  const lists = await mapLimit(seedArtists, 4, (seed) =>
    tryOrSkip(async () => (await lfm.similarArtists(seed.name, 30)).map((s) => ({ ...s, seed: seed.name })), isFatal),
  );
  const similar = new Map<string, SimilarPick>();
  for (const s of lists.flat()) {
    if (!s) continue;
    const key = normalizeName(s.name);
    if (topNames.has(key)) continue;
    if ((similar.get(key)?.match ?? -1) < s.match) similar.set(key, s);
  }

  // Sample artists weighted by similarity, without replacement.
  const remaining = [...similar.values()];
  const picks: SimilarPick[] = [];
  const wanted = Math.ceil(count / albumsPerArtist) + 2;
  while (picks.length < wanted && remaining.length) {
    const pick = weightedPick(remaining, (s) => s.match, rng)!;
    picks.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
  }

  const perArtist = await mapLimit(picks, 3, (pick) =>
    tryOrSkip(async () => {
      const artist = await resolveArtist(pick.name, client);
      if (!artist) return [];
      const albums = dedupeAlbums((await getArtistAlbums(artist.id, 20, client)).filter(isProperAlbum)).filter(
        (a) => !library.has(a),
      );
      return shuffle(albums, rng)
        .slice(0, albumsPerArtist)
        .map((a) => toCandidate(a, { kind: 'similar', to: pick.seed }, pick.match));
    }, isFatal),
  );
  return perArtist
    .flatMap((c) => c ?? [])
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

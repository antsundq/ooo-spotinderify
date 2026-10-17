// Adjacent pool: albums by artists similar to my top artists (via Last.fm), not in my library.

import { lastfm, type LastfmClient } from '../api/lastfm';
import { getArtistAlbums, spotify, type SpotifyClient } from '../api/spotify';
import {
  artistHasExcludedGenre,
  checkKidsArtist,
  isExcludedArtist,
  isKidsCandidate,
  loadExclusions,
  loadKidsBlocklist,
} from './filters';
import { isFatal, loadLibrary, loadTopArtists, orQuotaError } from './library';
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

  // Similar artists for a random handful of my top artists, skipping kids' music seeds.
  // Keep the best match per artist.
  const [blocklist, exclusions] = await Promise.all([loadKidsBlocklist(), loadExclusions()]);
  const seedPool = shuffle(top, rng).filter((a) => !blocklist.has(normalizeName(a.name)));
  const lists: SimilarPick[][] = [];
  let next = 0;
  while (lists.length < seeds && next < seedPool.length) {
    const batch = seedPool.slice(next, next + seeds - lists.length);
    next += batch.length;
    const results = await mapLimit(batch, 4, (seed) =>
      tryOrSkip(async () => {
        const similarList = await lfm.similarArtists(seed.name, 30);
        const names = similarList.map((s) => s.name);
        if (await checkKidsArtist(lfm, seed.name, names)) {
          for (const n of [seed.name, ...names]) blocklist.add(normalizeName(n));
          return undefined;
        }
        return similarList.map((s) => ({ ...s, seed: seed.name }));
      }, isFatal),
    );
    for (const r of results) if (r) lists.push(r);
  }
  const similar = new Map<string, SimilarPick>();
  for (const s of lists.flat()) {
    if (!s) continue;
    const key = normalizeName(s.name);
    if (topNames.has(key) || blocklist.has(key) || isExcludedArtist(s.name, exclusions)) continue;
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
      // Genre check first: it only costs a (cached) Last.fm call, not Spotify quota.
      if (await artistHasExcludedGenre(lfm, pick.name, exclusions)) return [];
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
  const result = perArtist
    .flatMap((c) => c ?? [])
    .filter((c) => !isKidsCandidate(c, blocklist))
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
  return orQuotaError(result, client);
}

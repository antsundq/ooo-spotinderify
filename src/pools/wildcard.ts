// Wildcard pool: top albums for a tag from my taste (or occasionally one I've never touched), via Last.fm.

import { lastfm, type LastfmClient } from '../api/lastfm';
import { spotify, type SpotifyClient } from '../api/spotify';
import {
  artistHasExcludedGenre,
  isExcludedArtist,
  isExcludedTag,
  isKidsCandidate,
  loadExclusions,
  loadKidsBlocklist,
  type Exclusions,
} from './filters';
import { isFatal, loadLibrary, loadTopArtists, orQuotaError } from './library';
import { albumKeyOf, normalizeName, resolveAlbum, toCandidate } from './resolve';
import type { AlbumCandidate } from './types';
import { mapLimit, shuffle, tryOrSkip, weightedPick, type Rng } from './util';

/** Broad genres to wander into when a tag is not part of my usual taste. */
export const EXPLORE_TAGS = [
  'jazz', 'soul', 'funk', 'folk', 'ambient', 'classical', 'blues', 'reggae', 'afrobeat', 'bossa nova',
  'krautrock', 'shoegaze', 'post-rock', 'trip-hop', 'country', 'hip-hop', 'electronic', 'punk', 'metal',
  'psychedelic', 'singer-songwriter', 'dream pop', 'latin', 'world', 'new wave', 'disco', 'gospel',
];

/** Personal or meaningless tags that make poor discovery seeds. */
const JUNK_TAG = /seen live|favou?rite|albums i own|owned|spotify|my |under \d+|awesome|beautiful|love/i;

export interface TagWeight {
  tag: string;
  weight: number;
}

/** Sums Last.fm tag counts across artists, dropping junk tags and tags that are just an artist's name. */
export function aggregateTags(perArtist: { artist: string; tags: { name: string; count: number }[] }[]): TagWeight[] {
  const artistNames = new Set(perArtist.map((a) => normalizeName(a.artist)));
  const weights = new Map<string, number>();
  for (const { tags } of perArtist) {
    for (const t of tags.slice(0, 10)) {
      const tag = t.name.toLowerCase().trim();
      if (!tag || JUNK_TAG.test(tag) || artistNames.has(normalizeName(tag))) continue;
      weights.set(tag, (weights.get(tag) ?? 0) + Math.max(1, t.count));
    }
  }
  return [...weights].map(([tag, weight]) => ({ tag, weight })).sort((a, b) => b.weight - a.weight);
}

/** Mostly weighted picks from my own tags; with probability `exploreChance`, a tag I've never touched. */
export function pickTags(
  mine: TagWeight[],
  n: number,
  exploreChance: number,
  rng: Rng,
  exclusions: Exclusions = { artists: [], genres: [] },
): string[] {
  // Sample without replacement, so n distinct tags come back whenever that many exist.
  const mineLeft = mine.filter((t) => !isExcludedTag(t.tag, exclusions)).slice(0, 15);
  const myTagSet = new Set(mine.map((t) => t.tag));
  const untouchedLeft = EXPLORE_TAGS.filter((t) => !myTagSet.has(t) && !isExcludedTag(t, exclusions));
  const picked: string[] = [];
  while (picked.length < n && (mineLeft.length || untouchedLeft.length)) {
    const explore = !mineLeft.length || (untouchedLeft.length > 0 && rng() < exploreChance);
    if (explore) {
      picked.push(...untouchedLeft.splice(Math.floor(rng() * untouchedLeft.length), 1));
    } else {
      const pick = weightedPick(mineLeft, (t) => t.weight, rng)!;
      mineLeft.splice(mineLeft.indexOf(pick), 1);
      picked.push(pick.tag);
    }
  }
  return picked;
}

export interface WildcardOptions {
  count?: number;
  tags?: number;
  exploreChance?: number;
  rng?: Rng;
  client?: SpotifyClient;
  lfm?: LastfmClient;
}

export async function wildcardPool({
  count = 20,
  tags = 3,
  exploreChance = 0.25,
  rng = Math.random,
  client = spotify,
  lfm = lastfm,
}: WildcardOptions = {}): Promise<AlbumCandidate[]> {
  const [top, library, blocklist, exclusions] = await Promise.all([
    loadTopArtists(client),
    loadLibrary(client),
    loadKidsBlocklist(),
    loadExclusions(),
  ]);
  const tasteArtists = top.filter((a) => !blocklist.has(normalizeName(a.name))).slice(0, 10);
  const perArtist = await mapLimit(tasteArtists, 4, async (a) => ({
    artist: a.name,
    tags: (await tryOrSkip(() => lfm.artistTopTags(a.name), isFatal)) ?? [],
  }));
  const chosen = pickTags(aggregateTags(perArtist), tags, exploreChance, rng, exclusions);

  const perTag = Math.ceil(count / Math.max(1, chosen.length));
  const seen = new Set<string>();
  const results = await mapLimit(chosen, 2, async (tag) => {
    const page = 1 + Math.floor(rng() * 3);
    const albums = shuffle((await tryOrSkip(() => lfm.tagTopAlbums(tag, page, 50), isFatal)) ?? [], rng);
    const out: AlbumCandidate[] = [];
    // Each attempt can cost a Spotify search, so cap attempts at twice the target.
    for (const lf of albums.slice(0, perTag * 2)) {
      if (out.length >= perTag) break;
      if (isExcludedArtist(lf.artist, exclusions)) continue;
      if (await tryOrSkip(() => artistHasExcludedGenre(lfm, lf.artist, exclusions), isFatal)) continue;
      const album = await tryOrSkip(() => resolveAlbum(lf.artist, lf.name, client), isFatal);
      if (!album || library.has(album)) continue;
      const key = albumKeyOf(album);
      if (seen.has(key)) continue;
      seen.add(key);
      const candidate = toCandidate(album, { kind: 'tag', tag }, rng());
      if (!isKidsCandidate(candidate, blocklist)) out.push(candidate);
    }
    return out;
  });
  return orQuotaError(results.flat().slice(0, count), client);
}

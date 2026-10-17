// Content filters for discovery: children's music.
//
// Kids' artists are hard to spot: Spotify no longer returns artist genres, and Last.fm
// usually has no tags for them (e.g. Swedish "Arne Alligator", "Bolibompa"). Their
// Last.fm similar-artist lists, though, are full of names like "Barnens Favoriter" or
// "HeyKids Barnsånger". So an artist counts as kids' music if its own tags say so, or if
// several of its similar artists have kids-y names. Detected artists, and everyone in
// their similarity cluster, go into a persistent blocklist that all pools check.

import type { LastfmClient } from '../api/lastfm';
import { kvGet, kvSet } from '../store/db';
import { normalizeName } from './resolve';
import type { AlbumCandidate } from './types';

const KIDS_TAG = /\b(children'?s?|kids|nursery|lullab(y|ies)|barnmusik|barnvisor|kindermusik|kinderlieder)\b/i;

/** Artist or album names that clearly mean children's music (Swedish and English). */
const KIDS_TEXT =
  /(\bbarnens\b|barns[åa]nger|barnvisor|barnmusik|barnkör|\bför barn\b|children'?s songs|nursery rhymes|\blullab(y|ies)\b|\bkids songs\b|\bbolibompa\b|\bbabblarna\b|kinderlieder)/i;

/** How many similar artists with kids-y names it takes to call a cluster kids' music. */
const CLUSTER_HITS = 2;

const BLOCKLIST_KEY = 'filters.kidsArtists';

export function hasKidsTags(tags: { name: string }[]): boolean {
  return tags.slice(0, 3).some((t) => KIDS_TAG.test(t.name));
}

export function looksLikeKidsText(s: string): boolean {
  return KIDS_TEXT.test(s);
}

/** Decides from data already at hand: the artist's top tags and its similar-artist names. */
export function isKidsCluster(name: string, tags: { name: string }[], similarNames: string[]): boolean {
  if (looksLikeKidsText(name) || hasKidsTags(tags)) return true;
  return similarNames.filter(looksLikeKidsText).length >= CLUSTER_HITS;
}

export async function loadKidsBlocklist(): Promise<Set<string>> {
  return new Set((await kvGet<string[]>(BLOCKLIST_KEY)) ?? []);
}

export async function addToKidsBlocklist(names: string[]): Promise<void> {
  const set = await loadKidsBlocklist();
  for (const n of names) set.add(normalizeName(n));
  await kvSet(BLOCKLIST_KEY, [...set]);
}

export function isKidsCandidate(c: Pick<AlbumCandidate, 'artist' | 'name'>, blocklist: Set<string>): boolean {
  return blocklist.has(normalizeName(c.artist)) || looksLikeKidsText(c.artist) || looksLikeKidsText(c.name);
}

/**
 * Checks one artist against Last.fm, blocklisting it and its similar artists if it is kids' music.
 * `similarNames` can be passed when the caller already fetched them.
 */
export async function checkKidsArtist(lfm: LastfmClient, name: string, similarNames?: string[]): Promise<boolean> {
  const [tags, similar] = await Promise.all([
    lfm.artistTopTags(name),
    similarNames ?? lfm.similarArtists(name, 30).then((s) => s.map((x) => x.name)),
  ]);
  const kids = isKidsCluster(name, tags, similar);
  if (kids) await addToKidsBlocklist([name, ...similar]);
  return kids;
}

// --- User exclusions (settings) -------------------------------------------------

export interface Exclusions {
  artists: string[];
  genres: string[];
}

const EXCLUSIONS_KEY = 'settings.exclusions';

export async function loadExclusions(): Promise<Exclusions> {
  return (await kvGet<Exclusions>(EXCLUSIONS_KEY)) ?? { artists: [], genres: [] };
}

export async function saveExclusions(ex: Exclusions): Promise<void> {
  const clean = (list: string[]) => [...new Set(list.map((s) => s.trim()).filter(Boolean))];
  await kvSet(EXCLUSIONS_KEY, { artists: clean(ex.artists), genres: clean(ex.genres) });
}

export function isExcludedArtist(artist: string, ex: Exclusions): boolean {
  const name = normalizeName(artist);
  return ex.artists.some((a) => normalizeName(a) === name);
}

/** True if a tag names an excluded genre, word-wise: excluding "metal" also excludes "death metal". */
export function isExcludedTag(tag: string, ex: Exclusions): boolean {
  const words = ` ${normalizeName(tag)} `;
  return ex.genres.some((g) => words.includes(` ${normalizeName(g)} `));
}

/** True if any of an artist's top Last.fm tags is an excluded genre. */
export function hasExcludedGenre(tags: { name: string }[], ex: Exclusions): boolean {
  return tags.slice(0, 5).some((t) => isExcludedTag(t.name, ex));
}

/** Checks an artist's genres via Last.fm (cached). Skips the lookup when no genres are excluded. */
export async function artistHasExcludedGenre(lfm: LastfmClient, artist: string, ex: Exclusions): Promise<boolean> {
  if (!ex.genres.length) return false;
  return hasExcludedGenre(await lfm.artistTopTags(artist), ex);
}

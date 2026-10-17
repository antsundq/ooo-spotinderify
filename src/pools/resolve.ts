// Name normalization, album dedupe and Last.fm → Spotify matching.

import {
  searchAlbums,
  searchArtists,
  spotify,
  type SimplifiedAlbum,
  type SpotifyArtist,
  type SpotifyClient,
} from '../api/spotify';
import { idbCache, MAPPING_PREFIX, type ResponseCache } from '../store/db';
import type { AlbumCandidate, CandidateSource } from './types';

const EDITION_WORDS =
  "deluxe|expanded|remaster(?:ed)?|anniversary|edition|version|bonus|reissue|mono|stereo|special|collector'?s|legacy|super";

/** "(Deluxe Edition)", "[2011 Remaster]" and similar bracketed suffixes. */
const BRACKET_EDITION = new RegExp(`\\s*[(\\[][^)\\]]*\\b(?:${EDITION_WORDS})\\b[^)\\]]*[)\\]]`, 'gi');
/** " - Remastered 2009", " - Deluxe Version" and similar dash suffixes. */
const DASH_EDITION = new RegExp(`\\s+[-–—]\\s+[^-–—]*\\b(?:${EDITION_WORDS})\\b.*$`, 'i');

const COMPILATION_NAME = /\b(greatest hits|best of|the very best|the essential|anthology|hits collection)\b/i;

/** Letters that NFKD does not decompose into ASCII. */
const FOLD: Record<string, string> = { æ: 'ae', œ: 'oe', ø: 'o', ß: 'ss', þ: 'th', ð: 'd', đ: 'd', ł: 'l', ı: 'i' };

/** Lowercase, strip accents and punctuation, "&" → "and", drop a leading "the". */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[æœøßþðđłı]/g, (c) => FOLD[c]!)
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '')
    .replace(/\s+/g, ' ');
}

/** Like `normalizeName`, but first removes edition suffixes so "X (Deluxe)" and "X" compare equal. */
export function normalizeTitle(s: string): string {
  return normalizeName(stripEdition(s));
}

export function stripEdition(s: string): string {
  const stripped = s.replace(BRACKET_EDITION, '').replace(DASH_EDITION, '').trim();
  return stripped || s;
}

export function isEditionVariant(name: string): boolean {
  return stripEdition(name) !== name.trim();
}

export function isCompilation(album: Pick<SimplifiedAlbum, 'album_type' | 'name'>): boolean {
  return album.album_type === 'compilation' || COMPILATION_NAME.test(album.name);
}

/** Full-length studio-style albums only: no singles/EPs, no compilations. */
export function isProperAlbum(album: Pick<SimplifiedAlbum, 'album_type' | 'name'>): boolean {
  return album.album_type === 'album' && !isCompilation(album);
}

export function albumKey(artist: string, title: string): string {
  return `${normalizeName(artist)}|${normalizeTitle(title)}`;
}

export function albumKeyOf(album: Pick<SimplifiedAlbum, 'name' | 'artists'>): string {
  return albumKey(album.artists[0]?.name ?? '', album.name);
}

/**
 * Collapses albums that are the same release in different editions.
 * Keeps the standard version when one exists, otherwise the first seen. Preserves input order.
 */
export function dedupeAlbums<T extends Pick<SimplifiedAlbum, 'name' | 'artists'>>(albums: T[]): T[] {
  const chosen = new Map<string, T>();
  for (const album of albums) {
    const key = albumKeyOf(album);
    const current = chosen.get(key);
    if (!current || (isEditionVariant(current.name) && !isEditionVariant(album.name))) {
      chosen.set(key, album);
    }
  }
  const keep = new Set(chosen.values());
  return albums.filter((a) => keep.has(a));
}

/** Picks the search result that is the same artist, by normalized name. */
export function matchArtist(results: SpotifyArtist[], name: string): SpotifyArtist | undefined {
  const target = normalizeName(name);
  return results.find((a) => normalizeName(a.name) === target);
}

/** Picks the search result that is the same album by the same artist, preferring the standard edition. */
export function matchAlbum(results: SimplifiedAlbum[], artist: string, title: string): SimplifiedAlbum | undefined {
  const targetArtist = normalizeName(artist);
  const targetTitle = normalizeTitle(title);
  const matches = results.filter(
    (a) =>
      isProperAlbum(a) &&
      normalizeTitle(a.name) === targetTitle &&
      a.artists.some((x) => normalizeName(x.name) === targetArtist),
  );
  return dedupeAlbums(matches)[0];
}

export function toCandidate(album: SimplifiedAlbum, source: CandidateSource, score: number): AlbumCandidate {
  const artist = album.artists[0];
  const year = Number.parseInt(album.release_date?.slice(0, 4) ?? '', 10);
  return {
    uri: album.uri,
    name: album.name,
    artist: artist?.name ?? 'Unknown artist',
    artistId: artist?.id ?? '',
    year: Number.isFinite(year) ? year : undefined,
    // Spotify lists images widest first.
    coverUrl: album.images[0]?.url,
    source,
    score,
  };
}

// --- Cached resolution ---------------------------------------------------------

/** Found mappings never change, so keep them forever. Misses may start matching later (new uploads). */
const MISS_TTL_MS = 30 * 24 * 60 * 60_000;

export async function resolveArtist(
  name: string,
  client: SpotifyClient = spotify,
  cache: ResponseCache = idbCache,
): Promise<SpotifyArtist | undefined> {
  const key = `${MAPPING_PREFIX}artist:${normalizeName(name)}`;
  const cached = await cache.get(key);
  if (cached !== undefined) return (cached as SpotifyArtist | null) ?? undefined;
  const found = matchArtist(await searchArtists(name, client), name);
  await cache.set(key, found ?? null, found ? Infinity : MISS_TTL_MS);
  return found;
}

export async function resolveAlbum(
  artist: string,
  title: string,
  client: SpotifyClient = spotify,
  cache: ResponseCache = idbCache,
): Promise<SimplifiedAlbum | undefined> {
  const key = `${MAPPING_PREFIX}album:${albumKey(artist, title)}`;
  const cached = await cache.get(key);
  if (cached !== undefined) return (cached as SimplifiedAlbum | null) ?? undefined;
  const found = matchAlbum(await searchAlbums(artist, stripEdition(title), client), artist, title);
  await cache.set(key, found ?? null, found ? Infinity : MISS_TTL_MS);
  return found;
}

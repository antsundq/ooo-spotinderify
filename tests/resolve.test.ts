import { describe, expect, it } from 'vitest';
import type { SimplifiedAlbum } from '../src/api/spotify';
import {
  dedupeAlbums,
  isCompilation,
  isEditionVariant,
  isProperAlbum,
  matchAlbum,
  matchArtist,
  normalizeName,
  normalizeTitle,
  toCandidate,
} from '../src/pools/resolve';

let n = 0;
function album(name: string, artist = 'Artist', type: SimplifiedAlbum['album_type'] = 'album'): SimplifiedAlbum {
  n++;
  return {
    id: `id${n}`,
    uri: `spotify:album:id${n}`,
    name,
    album_type: type,
    release_date: '1999-05-01',
    release_date_precision: 'day',
    total_tracks: 10,
    images: [{ url: `https://img/${n}`, width: 640, height: 640 }],
    artists: [{ id: `a-${artist}`, name: artist, uri: `spotify:artist:a-${artist}` }],
  };
}

describe('normalizeName', () => {
  it.each([
    ['The Beatles', 'beatles'],
    ['Beyoncé', 'beyonce'],
    ['Simon & Garfunkel', 'simon and garfunkel'],
    ['  AC/DC ', 'ac dc'],
    ['Sigur Rós', 'sigur ros'],
    ['Björk', 'bjork'],
    ['Ágætis byrjun', 'agaetis byrjun'],
    ['Mew – Frengers', 'mew frengers'],
    ['Motörhead', 'motorhead'],
    ['Kaizers Orkester – Ompa til du dør', 'kaizers orkester ompa til du dor'],
    ['坂本龍一', '坂本龍一'],
    ['Theory of a Deadman', 'theory of a deadman'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });
});

describe('normalizeTitle', () => {
  it.each([
    ['Abbey Road (Remastered 2009)', 'abbey road'],
    ['Abbey Road - Remastered 2009', 'abbey road'],
    ['Rumours (Super Deluxe)', 'rumours'],
    ['OK Computer [Collector’s Edition]', 'ok computer'],
    ["OK Computer (Collector's Edition)", 'ok computer'],
    ['Kid A (Expanded Edition)', 'kid a'],
    ['Blue (50th Anniversary Edition)', 'blue'],
    ['Pet Sounds (Mono & Stereo)', 'pet sounds'],
    ['Live at Leeds (Live)', 'live at leeds live'],
    ['Songs in the Key of Life', 'songs in the key of life'],
    ['Deluxe', 'deluxe'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });
});

describe('edition and compilation detection', () => {
  it('detects edition variants', () => {
    expect(isEditionVariant('Nevermind (Deluxe Edition)')).toBe(true);
    expect(isEditionVariant('Nevermind - 20th Anniversary Remaster')).toBe(true);
    expect(isEditionVariant('Nevermind')).toBe(false);
    expect(isEditionVariant('Deluxe')).toBe(false);
  });

  it('detects compilations by type and name', () => {
    expect(isCompilation(album('Whatever', 'X', 'compilation'))).toBe(true);
    expect(isCompilation(album('Greatest Hits'))).toBe(true);
    expect(isCompilation(album('The Very Best of Fleetwood Mac'))).toBe(true);
    expect(isCompilation(album('Rumours'))).toBe(false);
  });

  it('only keeps full albums', () => {
    expect(isProperAlbum(album('Rumours'))).toBe(true);
    expect(isProperAlbum(album('Dreams', 'X', 'single'))).toBe(false);
    expect(isProperAlbum(album('Best Of', 'X'))).toBe(false);
  });
});

describe('dedupeAlbums', () => {
  it('keeps the standard edition over deluxe, regardless of order', () => {
    const deluxe = album('In Rainbows (Deluxe)', 'Radiohead');
    const standard = album('In Rainbows', 'Radiohead');
    const other = album('Kid A', 'Radiohead');
    expect(dedupeAlbums([deluxe, other, standard])).toEqual([other, standard]);
    expect(dedupeAlbums([standard, deluxe, other])).toEqual([standard, other]);
  });

  it('keeps one deluxe version when no standard exists', () => {
    const a = album('Blue (Deluxe)', 'Joni Mitchell');
    const b = album('Blue - 2021 Remaster', 'Joni Mitchell');
    expect(dedupeAlbums([a, b])).toEqual([a]);
  });

  it('does not merge same title by different artists', () => {
    const a = album('Greatest Show', 'A');
    const b = album('Greatest Show', 'B');
    expect(dedupeAlbums([a, b])).toEqual([a, b]);
  });

  it('treats "The X" and "X" artists as the same', () => {
    const a = album('Revolver', 'The Beatles');
    const b = album('Revolver (Remastered)', 'Beatles');
    expect(dedupeAlbums([a, b])).toEqual([a]);
  });
});

describe('matching', () => {
  it('matches an album ignoring edition and the leading "the"', () => {
    const results = [
      album('Abbey Road (Super Deluxe Edition)', 'The Beatles'),
      album('Abbey Road (Remastered)', 'The Beatles'),
      album('Abbey Road', 'The Beatles'),
      album('Abbey Road', 'Tribute Band'),
    ];
    expect(matchAlbum(results, 'Beatles', 'Abbey Road')).toBe(results[2]);
  });

  it('skips singles and compilations when matching', () => {
    const results = [album('Hello', 'Adele', 'single'), album('Hello', 'Adele', 'compilation')];
    expect(matchAlbum(results, 'Adele', 'Hello')).toBeUndefined();
  });

  it('matches by any credited artist', () => {
    const a = album('Watch the Throne', 'Jay-Z');
    a.artists.push({ id: 'kw', name: 'Kanye West', uri: 'spotify:artist:kw' });
    expect(matchAlbum([a], 'Kanye West', 'Watch The Throne')).toBe(a);
  });

  it('returns undefined when nothing matches', () => {
    expect(matchAlbum([album('Other', 'X')], 'X', 'Missing')).toBeUndefined();
  });

  it('matches artists by normalized name', () => {
    const artists = [
      { id: '1', name: 'Sigur Rós Tribute', uri: 'spotify:artist:1', images: [] },
      { id: '2', name: 'Sigur Rós', uri: 'spotify:artist:2', images: [] },
    ];
    expect(matchArtist(artists, 'sigur ros')?.id).toBe('2');
  });
});

describe('toCandidate', () => {
  it('maps fields', () => {
    const a = album('Rumours', 'Fleetwood Mac');
    expect(toCandidate(a, { kind: 'tag', tag: 'rock' }, 3)).toMatchObject({
      uri: a.uri,
      name: 'Rumours',
      artist: 'Fleetwood Mac',
      artistId: 'a-Fleetwood Mac',
      year: 1999,
      coverUrl: a.images[0]!.url,
      source: { kind: 'tag', tag: 'rock' },
      score: 3,
    });
  });
});

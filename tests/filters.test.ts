import { describe, expect, it } from 'vitest';
import { isKidsCandidate, isKidsCluster, looksLikeKidsText } from '../src/pools/filters';
import { isLiveOrRemix, isProperAlbum } from '../src/pools/resolve';

describe('children\'s music', () => {
  // Real Last.fm data for "Arne Alligator & Djungeltrumman": no tags, and kids-y similar artists.
  const arneSimilar = [
    'Bolibompa', 'Babblarna', 'Klonk & Tut', 'Kompisbandet', 'Yankho', 'Saga & Simon', 'Barnens Favoriter',
    'Duran & Mollan', 'Klas Widén', 'HeyKids Barnsånger på Svenska', 'Duvungarna', 'Pappa Kapsyl',
  ];

  it('detects an untagged kids artist from its similarity cluster', () => {
    expect(isKidsCluster('Arne Alligator & Djungeltrumman', [], arneSimilar)).toBe(true);
  });

  it('detects kids artists from their own tags', () => {
    expect(isKidsCluster('Duran & Mollan', [{ name: 'kids' }, { name: 'swedish' }], [])).toBe(true);
    expect(isKidsCluster('X', [{ name: "children's music" }], [])).toBe(true);
  });

  it('leaves regular artists alone', () => {
    const tags = [{ name: 'Progressive metal' }, { name: 'Progressive rock' }];
    expect(isKidsCluster('Ayreon', tags, ['Star One', 'Arjen Anthony Lucassen', 'Kids See Ghosts'])).toBe(false);
    expect(isKidsCluster('Band of Horses', [{ name: 'indie' }], ['The National', 'The Decemberists'])).toBe(false);
  });

  it('recognises kids titles in Swedish and English', () => {
    expect(looksLikeKidsText('God jul önskar vi (er) alla barn')).toBe(false);
    expect(looksLikeKidsText('Barnens favoriter')).toBe(true);
    expect(looksLikeKidsText('Rörelselek med Bolibompa')).toBe(true);
    expect(looksLikeKidsText('Nursery Rhymes Vol. 2')).toBe(true);
    expect(looksLikeKidsText('Jimmy Barnes')).toBe(false);
    expect(looksLikeKidsText('Lullaby')).toBe(true);
  });

  it('filters candidates by blocklist or title', () => {
    const blocklist = new Set(['arne alligator and djungeltrumman']);
    expect(isKidsCandidate({ artist: 'Arne Alligator & Djungeltrumman', name: 'Djungeldans' }, blocklist)).toBe(true);
    expect(isKidsCandidate({ artist: 'Barnens Favoriter', name: 'Hej tomtegubbar!' }, new Set())).toBe(true);
    expect(isKidsCandidate({ artist: 'Rush', name: 'Moving Pictures' }, blocklist)).toBe(false);
  });
});

describe('live and remix albums', () => {
  it.each([
    'Boxer (Live in Brussels)',
    'Quarantième: Live à Paris',
    'Home Invasion: In Concert At The Royal Albert Hall (Live)',
    'The Theater Equation (Live)',
    'Outta My System (Remixez Y Friendz)',
    'Into The Electric Castle (20th Anniversary Remix)',
    'MTV Unplugged in New York',
    'Live at Leeds',
    'Get All You Deserve [Live]',
    'Remixes 81-04',
  ])('filters %s', (name) => {
    expect(isLiveOrRemix(name)).toBe(true);
    expect(isProperAlbum({ album_type: 'album', name })).toBe(false);
  });

  it.each(['Live Through This', 'Alive', 'Evil Urges', 'Deliverance', 'Olive', 'Lively Up Yourself'])('keeps %s', (name) => {
    expect(isLiveOrRemix(name)).toBe(false);
  });
});

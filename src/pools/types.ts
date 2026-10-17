export type CandidateSource =
  | { kind: 'favorite' }
  | { kind: 'similar'; to: string }
  | { kind: 'tag'; tag: string };

export interface AlbumCandidate {
  uri: string;
  name: string;
  artist: string;
  artistId: string;
  year: number | undefined;
  coverUrl: string | undefined;
  source: CandidateSource;
  /** Pool-specific rank; higher means show sooner. */
  score: number;
}

export function sourceLabel(source: CandidateSource): string {
  switch (source.kind) {
    case 'favorite':
      return 'Favorite';
    case 'similar':
      return `Similar to ${source.to}`;
    case 'tag':
      return `Tag: ${source.tag}`;
  }
}

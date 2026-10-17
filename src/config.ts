export const config = {
  spotifyClientId: import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined,
  lastfmApiKey: import.meta.env.VITE_LASTFM_API_KEY as string | undefined,
  redirectUri: import.meta.env.VITE_REDIRECT_URI as string | undefined,
};

/** Env vars that are missing, so the UI can say what to put in .env.local. */
export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!config.spotifyClientId) missing.push('VITE_SPOTIFY_CLIENT_ID');
  if (!config.redirectUri) missing.push('VITE_REDIRECT_URI');
  return missing;
}

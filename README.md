# Spotinder

A personal "Tinder for albums" on top of Spotify. Swipe through album cards:

- **Right** plays the whole album, in order, on your active Spotify device
- **Left** skips it and teaches the app
- **Up** saves it to your library without playing
- **Tap** flips the card to show the tracklist and runtime

A slider sets the mix from **old favorites** (your saved albums you haven't heard in a while) to **new discoveries** (artists similar to your favorites and top albums for your genres, via Last.fm).

It's a browser-only PWA (Vite + TypeScript, no backend). Spotify login uses Authorization Code with PKCE, and everything the app learns lives in IndexedDB on the device.

## What is this, and can I use it?

This is a **hobby project I built for myself**. It's public so others can read the code or run their own copy, but it isn't a product or a service.

- **The deployed site won't work for you.** It runs in Spotify's Development Mode, so only Spotify accounts I've allow-listed can log in. Anyone else is rejected at the Spotify login.
- **To use it yourself, run your own copy.** Fork the repo, create your own (free) Spotify developer app and Last.fm API key, and follow [Setup](#setup) and [Deploy](#deploy). Spotify Premium is required.
- **No data leaves your browser** except calls to Spotify and Last.fm. There is no server, account system, analytics or tracking. Your swipe history and learned preferences live in your browser's IndexedDB.
- **Not affiliated with Spotify or Last.fm.** It uses their public APIs under their developer terms.
- **No support or roadmap.** Issues and pull requests may go unanswered, and the code may change or break as the Spotify API changes.

## Setup

1. **Spotify app.** At <https://developer.spotify.com/dashboard>, click **Create app**:
   - Tick **Web API**.
   - Redirect URIs: `http://127.0.0.1:5173/callback` for development, plus your deployed URL with `/callback` (see [Deploy](#deploy)).
   - Copy the **Client ID**. You don't need the client secret.
2. **Last.fm API key.** Create one at <https://www.last.fm/api/account/create>. Only the **API key** is needed; never put the shared secret in this app.
3. **`.env.local`** (gitignored). Copy `.env.example` and fill it in:

   ```
   VITE_SPOTIFY_CLIENT_ID=...
   VITE_LASTFM_API_KEY=...
   VITE_REDIRECT_URI=http://127.0.0.1:5173/callback
   ```

4. Run it:

   ```bash
   npm install
   npm run dev
   ```

   Open **<http://127.0.0.1:5173>**. Spotify rejects `localhost` redirect URIs, so the dev server binds to the loopback IP. If you open `localhost`, the app redirects to `127.0.0.1`.

| Variable | Purpose |
|---|---|
| `VITE_SPOTIFY_CLIENT_ID` | Spotify app Client ID (public, safe in the bundle) |
| `VITE_LASTFM_API_KEY` | Last.fm API key for similar artists and tags (read-only, fine for a personal client-side app) |
| `VITE_REDIRECT_URI` | Must exactly match a redirect URI in the Spotify dashboard |
| `BASE_PATH` | Build-time only: sub-path the app is served from, e.g. `/ooo-spotinderify/` on GitHub Pages |

## Scripts

```bash
npm run dev        # dev server on http://127.0.0.1:5173
npm test           # Vitest unit tests
npm run typecheck
npm run build      # production build into dist/
```

## Deploy

### GitHub Pages

`.github/workflows/deploy.yml` tests, builds and publishes on every push to `main`.

1. Push the repo to GitHub.
2. **Settings → Pages → Source:** GitHub Actions.
3. **Settings → Secrets and variables → Actions → Variables:** add
   - `VITE_SPOTIFY_CLIENT_ID`
   - `VITE_LASTFM_API_KEY`
   - `VITE_REDIRECT_URI` = `https://<user>.github.io/<repo>/callback`
4. Add that same `https://<user>.github.io/<repo>/callback` as a redirect URI in the Spotify dashboard.
5. Push to `main`, or run the workflow by hand.

The workflow copies `index.html` to `404.html`, so `/callback` works on Pages, which doesn't support SPA rewrites.

### Netlify

`netlify.toml` has the build command and SPA redirect. Set the three `VITE_*` variables under **Site configuration → Environment variables**. Use `https://<site>.netlify.app/callback` as the redirect URI, both in the variable and in the Spotify dashboard.

### Install on your phone

Open the deployed URL. In iOS Safari, use **Share → Add to Home Screen**; in Android Chrome, use **Install app**. The app shell works offline, but swiping needs the network. Sessions survive overnight: the access token refreshes silently with the stored refresh token, which Spotify keeps valid for about six months.

## Spotify Development Mode limits

The app is meant to stay in Spotify's Development Mode:

- **Premium required.** The app owner needs Spotify Premium, and playback control needs Premium too.
- **Allow-listed users only**, up to 5. Add others under **User Management** in the dashboard.
- **Shared quota.** All your dev-mode apps share one request quota. When it runs out, Spotify answers `429` with `reason: "QUOTA_EXCEEDED"`. The app then stops calling Spotify for 15 minutes (remembered across reloads) and serves what it has cached. Pools are snapshotted for 6 hours and API responses are cached, so normal use stays well under the limit.
- **Unavailable endpoints.** Recommendations, related artists, audio features, artist genres and batch endpoints are unavailable to new apps. Discovery comes from Last.fm instead.
- **Smaller pages.** `/search` and `/artists/{id}/albums` return at most 10 items per page.
- **Library endpoints** moved to `PUT/DELETE /me/library?uris=…` in February 2026.

## How it works

```
src/
  auth/pkce.ts        PKCE login, callback, token refresh (tokens in IndexedDB)
  api/spotify.ts      typed fetch wrapper: 429/Retry-After, QUOTA_EXCEEDED backoff, TTL cache
  api/lastfm.ts       artist.getSimilar, artist.getTopTags, tag.getTopAlbums
  pools/favorites.ts  saved albums, longest-unheard first
  pools/adjacent.ts   albums by artists similar to your top artists
  pools/wildcard.ts   top albums for one of your tags, or a genre you never touch
  pools/resolve.ts    name normalization, edition dedupe, Last.fm → Spotify matching
  pools/filters.ts    children's music detection, live/remix filter, your exclusions
  mixer/scoring.ts    slider weights, artist weights with 30-day half-life, anti-repeat
  mixer/deck.ts       lazily filled 15-card deck with background pool refills
  mixer/history.ts    swipe log, artist weights, undo
  ui/                 card, swipe gestures, playback, settings, debug page
```

- **Learning.** A right or up swipe adds +1 to the artist's weight and a left swipe −1. Weights halve every 30 days. Artists below −1.5 are suppressed, and liked artists come up more often.
- **Anti-repeat.** A left-swiped album stays hidden for 90 days, and a played or saved one for 14 days. The deck never shows more than 2 cards in a row from the same artist.
- **Children's music.** Spotify no longer returns genres, and Last.fm often has no tags for kids' artists. The app detects them from kids-named similar artists (Swedish and English) and blocklists the whole cluster.
- **Settings** (⋯ → Settings) has slider presets, excluded artists and genres, reset learned weights, and clear cache.
- **Debug page** (⋯ → Debug) shows the deck, the pool mix, raw pools and token status.

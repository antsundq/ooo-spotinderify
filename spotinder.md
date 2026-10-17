# Album Swipe — Build Plan

A personal "Tinder for albums" on top of Spotify. Swipe through album cards. Swipe right to play the whole album on my active Spotify device. Swipe left to skip and teach the app. A slider sets the mix from **old favorites** to **new discoveries**.

> **For Claude Code:** Work through the phases in order. Stop after each phase, run its acceptance check, and summarize before continuing. Ask before adding dependencies beyond the ones listed. Check current Spotify docs before writing any endpoint code, because the Web API changed in Feb–Jul 2026.

---

## Constraints (read first)

- **Spotify Development Mode.**
  - The app owner needs Spotify Premium.
  - Only allow-listed users can use the app. That is fine, since this app is only for me.
- **Search limit.** `/search` returns at most **10 results per type**. Paginate or narrow queries.
- **Quota.** Quota is shared across all my dev-mode apps.
  - Handle `429` responses.
  - If the response body has `reason: "QUOTA_EXCEEDED"`, it is a quota limit, not a rate limit. Back off hard.
  - Cache aggressively.
- **Unavailable endpoints.** Recommendations, related-artists and audio-features can't be used by new apps. Discovery must come from Last.fm or ListenBrainz.
- **Library endpoints.** These changed in Feb 2026. Saving and removing now use `/me/library` with Spotify URIs. Verify against the migration guide: https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
- **Redirect URIs.** Spotify accepts HTTPS URLs or the loopback address `http://127.0.0.1:<port>`. `localhost` is not accepted.

## Stack

- **Frontend:** Vite + TypeScript, built as a PWA. No framework, or Preact if it helps. Mobile-first, so it can be installed to the phone home screen.
- **Auth:** Spotify Authorization Code with PKCE, done entirely in the browser. No client secret and no backend.
- **Discovery:** Last.fm API (`artist.getSimilar`, `tag.getTopAlbums`). This uses a free API key, which is acceptable to keep client-side for a personal app.
- **State:** IndexedDB, through the `idb` package. It stores swipe history, artist weights and the API cache.
- **Tests:** Vitest for the scoring and pool logic.
- **Hosting:** GitHub Pages or Netlify over HTTPS, so the phone can reach it. During development use `http://127.0.0.1:5173`.

## Setup (me, before the session)

1. Create an app at https://developer.spotify.com/dashboard.
   - Choose Web API.
   - Add the redirect URIs `http://127.0.0.1:5173/callback` and the deployed URL plus `/callback`.
2. Get a Last.fm API key at https://www.last.fm/api/account/create.
3. Put both in `.env.local`:
   ```
   VITE_SPOTIFY_CLIENT_ID=...
   VITE_LASTFM_API_KEY=...
   VITE_REDIRECT_URI=http://127.0.0.1:5173/callback
   ```

---

## Phase 1 — Skeleton + auth

- Scaffold the Vite + TS project with a PWA manifest and service worker (`vite-plugin-pwa`).
- Implement PKCE login, the callback handler and token refresh. Store tokens in IndexedDB.
- Request these scopes:
  - `user-library-read`
  - `user-library-modify`
  - `user-top-read`
  - `user-read-recently-played`
  - `user-read-playback-state`
  - `user-modify-playback-state`
- Add a thin `spotify.ts` client:
  - Typed `fetch` wrapper that attaches the auth header.
  - Retry with `Retry-After` on 429.
  - Distinct error for `QUOTA_EXCEEDED`.
  - Response cache with a TTL.

**Accept:** I can log in, and the app shows my display name from `GET /me`. A refresh after an hour still works.

## Phase 2 — Data sources (candidate pools)

Each pool returns `AlbumCandidate { uri, name, artist, artistId, year, coverUrl, source }`.

1. **Favorites pool**
   - Source: `GET /me/albums`, paginated and cached for 24 h.
   - Score saved albums by how long since I last played them, using `GET /me/player/recently-played` plus my own swipe history.
   - Albums not heard in a long time rank higher.
2. **Adjacent pool**
   - Start from my top artists (`GET /me/top/artists`, medium and long term).
   - Get similar artists from Last.fm `artist.getSimilar`.
   - Resolve each to Spotify with `/search?type=artist`, then get albums with `GET /artists/{id}/albums?include_groups=album`.
   - Exclude albums already in my library.
3. **Wildcard pool**
   - Get the top tags of my top artists from Last.fm.
   - Pick a random tag and call `tag.getTopAlbums`, plus occasional tags I've never touched.
   - Resolve each album on Spotify with `/search?type=album` (10-result limit).

Resolution rules:
- Match on normalized artist and album names.
- Drop compilations, singles and "Deluxe" duplicates when a standard version exists.
- Cache every Last.fm-to-Spotify mapping permanently.

**Accept:** A debug page lists 20 candidates from each pool with cover art. Vitest covers the name normalization and dedupe logic.

## Phase 3 — Mixer + scoring

- A **discovery slider** (0–100) sets pool weights. For example:
  - 0 → favorites 80% / adjacent 20%
  - 50 → 40 / 40 / 20
  - 100 → 10 / 50 / 40
- Keep a per-artist weight in IndexedDB.
  - A right swipe adds +1 and a left swipe subtracts 1, decaying over about 30 days.
  - Albums whose artist weight falls below a threshold get suppressed.
- Never show the same album again within N days of a left swipe.
- No more than 2 cards in a row from the same artist.
- Build the deck lazily. Keep about 15 cards ready and refill in the background.

**Accept:** Unit tests cover the weighting, decay and anti-repeat rules. The deck visibly shifts as the slider moves.

## Phase 4 — Swipe UI

- A full-screen card shows:
  - Large cover art.
  - Album, artist and year.
  - A small source badge (Favorite / Similar to X / Tag: Y).
- Gestures: touch or pointer drag with rotation and fling. Buttons do the same for desktop.
  - **Right:** play the album.
  - **Left:** skip.
  - **Up:** save to library without playing.
- Tap the card to flip it and see the tracklist and total runtime (`GET /albums/{id}`).
- Show the discovery slider in a top bar, plus an undo button for the last swipe.

**Accept:** Swiping feels smooth on my phone in Safari and Chrome, at 60 fps with no layout jank.

## Phase 5 — Playback

- On a right swipe:
  1. Check `GET /me/player/devices`.
  2. If there is an active device, call `PUT /me/player/play` with `{ context_uri: albumUri }`.
  3. If no device is active, show a device picker. Transfer with `PUT /me/player` and then play.
  4. If there are no devices at all, show the message "Open Spotify on a device first."
- Turn shuffle off before playing, since albums should play in order.
- Show a "Now playing" mini-bar with a link back to the card.

**Accept:** A right swipe starts the album from track 1, in order, on my speaker or desktop or phone.

## Phase 6 — Polish + deploy

- Install as a PWA, with an offline shell (data still needs the network).
- Add a settings panel:
  - Slider presets.
  - Reset learned weights.
  - Excluded genres or artists.
  - Option to clear the cache.
- Deploy to GitHub Pages or Netlify, and add the production redirect URI in the Spotify dashboard.
- Write a short README covering setup, env vars and the dev-mode limits.

**Accept:** Installed on my phone, it works away from my desk and survives a token expiry overnight.

---

## Later ideas (not now)

- A **ListenBrainz** pool, which is open data and gives good collaborative-filtering recommendations.
- An **LLM wildcard** that sends my recent right-swipes to Claude and gets album suggestions back. This needs a tiny backend to keep the API key server-side.
- A "Mood/occasion" chip, such as focus, cooking or late night, that biases tags.
- Export my right-swipes to a "Swiped" playlist.

## File layout

```
src/
  auth/pkce.ts
  api/spotify.ts
  api/lastfm.ts
  pools/favorites.ts
  pools/adjacent.ts
  pools/wildcard.ts
  pools/resolve.ts        # Last.fm → Spotify matching
  mixer/deck.ts
  mixer/scoring.ts
  store/db.ts             # IndexedDB
  ui/card.ts
  ui/swipe.ts
  ui/player.ts
  main.ts
tests/
```

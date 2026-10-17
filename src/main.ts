import { registerSW } from 'virtual:pwa-register';
import { config, missingConfig } from './config';
import { getTokens, handleCallback, isCallback, login, logout } from './auth/pkce';
import { getMe, QuotaExceededError } from './api/spotify';
import { clearCache } from './store/db';
import { renderDebug } from './ui/debug';
import { mountDeckScreen } from './ui/screen';

registerSW({ immediate: true });

const app = document.querySelector<HTMLElement>('#app')!;
const appRoot = import.meta.env.BASE_URL;

function render(html: string): void {
  app.innerHTML = html;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function on(id: string, handler: () => void | Promise<void>): void {
  document.getElementById(id)?.addEventListener('click', () => void handler());
}

/** fetch() rejects with a TypeError when the network is unreachable. */
function isOffline(err: unknown): boolean {
  return !navigator.onLine || err instanceof TypeError;
}

function renderOffline(): void {
  render(`
    <section class="panel">
      <h1>You're offline</h1>
      <p>Spotinder needs the network to talk to Spotify. It will continue as soon as you're back online.</p>
      <button id="retry">Try again</button>
    </section>`);
  on('retry', boot);
  window.addEventListener('online', () => void boot(), { once: true });
}

function renderError(err: unknown): void {
  if (isOffline(err)) return renderOffline();
  const message = err instanceof QuotaExceededError
    ? `Spotify quota exceeded. Calls paused until ${new Date(err.blockedUntil).toLocaleTimeString()}.`
    : err instanceof Error ? err.message : String(err);
  render(`
    <section class="panel">
      <h1>Spotinder</h1>
      <p class="error">${escape(message)}</p>
      <button id="retry">Try again</button>
      <button id="login" class="secondary">Log in again</button>
    </section>`);
  on('retry', boot);
  on('login', login);
}

function renderLoggedOut(): void {
  render(`
    <section class="panel">
      <h1>Spotinder</h1>
      <p>Swipe through albums. Right plays the album on Spotify.</p>
      <button id="login">Log in with Spotify</button>
    </section>`);
  on('login', login);
}

let unmountScreen: (() => void) | undefined;

async function renderHome(): Promise<void> {
  render(`<section class="panel"><p>Loading…</p></section>`);
  const me = await getMe();
  unmountScreen = await mountDeckScreen(app, {
    displayName: me.display_name ?? me.id,
    onLogout: async () => {
      unmountScreen?.();
      await logout();
      await clearCache();
      renderLoggedOut();
    },
  });
}

async function boot(): Promise<void> {
  const missing = missingConfig();
  if (missing.length) {
    render(`
      <section class="panel">
        <h1>Setup needed</h1>
        <p>Add these to <code>.env.local</code> and restart the dev server:</p>
        <pre>${missing.join('\n')}</pre>
      </section>`);
    return;
  }

  try {
    if (isCallback(window.location)) {
      const params = new URLSearchParams(window.location.search);
      // Drop ?code= from the address bar before anything else can fail.
      window.history.replaceState(null, '', appRoot);
      await handleCallback(params);
    }
    unmountScreen?.();
    unmountScreen = undefined;
    if (!(await getTokens())) return renderLoggedOut();
    if (window.location.hash === '#/debug') return renderDebug(app);
    await renderHome();
  } catch (err) {
    console.error(err);
    renderError(err);
  }
}

if (window.location.hostname === 'localhost' && config.redirectUri?.includes('127.0.0.1')) {
  // Spotify rejects localhost redirect URIs, and IndexedDB is per-origin, so always use 127.0.0.1.
  window.location.replace(window.location.href.replace('//localhost', '//127.0.0.1'));
} else {
  window.addEventListener('hashchange', () => void boot());
  void boot();
}

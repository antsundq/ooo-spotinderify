import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  // BASE_PATH lets the same build run at a sub-path, e.g. /ooo-spotinderify/ on GitHub Pages.
  const base = loadEnv(mode, '.', '').BASE_PATH || '/';
  return {
    base,
    server: {
      // Spotify rejects "localhost" redirect URIs, so dev must run on the loopback IP.
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
    preview: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
    plugins: [
      VitePWA({
        registerType: 'autoUpdate',
        // globPatterns below already precaches the icons.
        includeManifestIcons: false,
        manifest: {
          name: 'Spotinder',
          short_name: 'Spotinder',
          description: 'Swipe through albums, play them on Spotify.',
          theme_color: '#121212',
          background_color: '#121212',
          display: 'standalone',
          orientation: 'portrait',
          start_url: base,
          scope: base,
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          ],
        },
        workbox: {
          // App shell is precached. API data always goes to the network (it has its own IndexedDB cache).
          navigateFallback: 'index.html',
          globPatterns: ['**/*.{js,css,html,svg,png}'],
          runtimeCaching: [
            {
              // Album covers rarely change; keep recent ones so the deck paints instantly.
              urlPattern: ({ url }) => url.hostname === 'i.scdn.co',
              handler: 'CacheFirst',
              options: {
                cacheName: 'covers',
                expiration: { maxEntries: 300, maxAgeSeconds: 30 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
      }),
    ],
  };
});

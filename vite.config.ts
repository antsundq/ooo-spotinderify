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
        includeAssets: ['icon.svg'],
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
          icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
        },
        workbox: {
          // App shell only. API data always goes to the network.
          navigateFallback: 'index.html',
          globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        },
      }),
    ],
  };
});

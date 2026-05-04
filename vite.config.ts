import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';

// Tauri builds (desktop + mobile) set TAURI_ENV_PLATFORM when invoking
// `npm run build` via tauri.conf.json's beforeBuildCommand. We use this to
// strip browser-only behaviours that don't make sense in a packaged app:
//
//   * the PWA service worker — it's only there to (a) precache for offline
//     and (b) graft COOP/COEP onto GH-Pages responses. A packaged Tauri
//     app is already offline and serves its own assets.
//   * the bootstrap "reload once the SW is in control" script in
//     src/routes/+layout.svelte — same reason.
//
// On Android specifically, registration *fails* with "failed to register
// a ServiceWorker for scope http://tauri.localhost/" because Chromium
// doesn't extend secure-context to `*.localhost` over plain HTTP. The
// failure surfaces as a console.error and (when the bootstrap reload
// awaits `serviceWorker.ready`) leaves a dangling promise. Skipping the
// PWA entirely on Tauri sidesteps both.
const isTauriBuild = !!process.env.TAURI_ENV_PLATFORM;

// SvelteKit's dev handler overrides vite.server.headers, so we register
// the isolation headers via middleware instead. Without these, SharedArrayBuffer
// is not exposed and threaded Stockfish won't load.
const crossOriginIsolation = (): Plugin => {
	const headers = {
		'Cross-Origin-Opener-Policy': 'same-origin',
		// Use `credentialless` so cross-origin fetches (Lichess API,
		// explorer, etc.) go through without requiring upstream CORP
		// headers. Still gives us SharedArrayBuffer for threaded
		// Stockfish; only drops cookies on cross-origin subresource
		// fetches, which we don't use (auth goes via Authorization
		// header, not cookies).
		'Cross-Origin-Embedder-Policy': 'credentialless'
	};
	const apply = (
		_req: unknown,
		res: { setHeader: (k: string, v: string) => void },
		next: () => void
	) => {
		for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
		next();
	};
	return {
		name: 'cross-origin-isolation',
		configureServer(server) {
			server.middlewares.use(apply);
		},
		configurePreviewServer(server) {
			server.middlewares.use(apply);
		}
	};
};

export default defineConfig({
	plugins: [
		crossOriginIsolation(),
		tailwindcss(),
		sveltekit(),
		...(isTauriBuild
			? []
			: [
					SvelteKitPWA({
						strategies: 'injectManifest',
						srcDir: 'src',
						filename: 'service-worker.ts',
						registerType: 'autoUpdate',
						injectRegister: 'auto',
						devOptions: { enabled: false },
						manifest: {
							name: 'COBRA — Chess Opening Builder and Repertoire Analyzer',
							short_name: 'COBRA',
							description: 'Build and drill chess opening repertoires.',
							theme_color: '#1e293b',
							background_color: '#0f172a',
							display: 'standalone',
							orientation: 'any',
							start_url: '/',
							scope: '/',
							icons: [
								{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
								{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }
							]
						},
						injectManifest: {
							globPatterns: ['**/*.{js,css,html,svg,woff2,wasm}'],
							maximumFileSizeToCacheInBytes: 5 * 1024 * 1024
						}
					})
				])
	],
	optimizeDeps: {
		exclude: ['lila-stockfish-web']
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'unit',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});

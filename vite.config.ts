import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';

// We still emit the PWA service worker for Tauri builds (set via
// TAURI_ENV_PLATFORM) — the overhead is small and it keeps the code
// paths uniform. Registration itself is gated at runtime in
// src/lib/pwa/UpdateBanner.svelte so packaged apps never call
// `serviceWorker.register`. That avoids Chromium's "failed to register a
// ServiceWorker for scope http://tauri.localhost/" error (Android
// WebView won't treat `*.localhost` over plain HTTP as a secure
// context) and skips the wasted precache work in a shell that already
// serves its assets locally.

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
		SvelteKitPWA({
			strategies: 'injectManifest',
			srcDir: 'src',
			filename: 'service-worker.ts',
			// `prompt` keeps a freshly-installed SW in the waiting state
			// until the user accepts the upgrade in UpdateBanner.svelte.
			// We register manually from that component (so `injectRegister`
			// is off) — this lets us gate registration on Tauri / non-secure
			// contexts and surface a "new version available" UI instead of
			// silently swapping the build out under the user.
			registerType: 'prompt',
			injectRegister: false,
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
	],
	optimizeDeps: {
		exclude: ['lila-stockfish-web']
	},
	// Build-time default for the hosted (Cloudflare) sync backend URL, read from
	// process.env.COBRA_SYNC_URL so a deploy can bake in the operator's Worker —
	// one shared backend for all users, who are isolated by Lichess identity.
	// Empty when unset (self-host / local dev), in which case users enter their
	// own URL in Settings.
	define: {
		__COBRA_SYNC_URL__: JSON.stringify(process.env.COBRA_SYNC_URL ?? '')
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

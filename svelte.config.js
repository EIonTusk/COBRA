import adapter from '@sveltejs/adapter-static';

// GitHub Pages serves the site from a subpath (`/COBRA/` for the
// EIonTusk/COBRA repo). Any other host (Cloudflare Pages, Netlify, localhost)
// serves from the root, so we switch based on an env var the deploy
// workflow sets.
const base = process.env.COBRA_BASE_PATH ?? '';

// Tauri builds set TAURI_ENV_PLATFORM. We use this to opt out of
// SvelteKit's auto-registration of src/service-worker.ts. On Android,
// Chromium refuses to register a SW against `http://tauri.localhost`
// (subdomains of localhost are not secure-context for SW purposes over
// plain HTTP), and the resulting registration error is noise — there
// is no offline gap to fill in a packaged app, and no GH-Pages COOP/COEP
// shim to need. (The PWA plugin in vite.config.ts is also disabled in
// Tauri builds; this covers SvelteKit's *own* SW auto-register, which
// runs independently of @vite-pwa.)
const isTauriBuild = !!process.env.TAURI_ENV_PLATFORM;

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: 'index.html',
			precompress: false,
			strict: false
		}),
		paths: {
			base
		},
		serviceWorker: {
			register: !isTauriBuild
		},
		alias: {
			$lib: 'src/lib'
		}
	}
};

export default config;

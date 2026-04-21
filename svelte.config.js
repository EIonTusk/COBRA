import adapter from '@sveltejs/adapter-static';

// GitHub Pages serves the site from a subpath (`/COBRA/` for the
// EIonTusk/COBRA repo). Any other host (Cloudflare Pages, Netlify, localhost)
// serves from the root, so we switch based on an env var the deploy
// workflow sets.
const base = process.env.COBRA_BASE_PATH ?? '';

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
		alias: {
			$lib: 'src/lib'
		}
	}
};

export default config;

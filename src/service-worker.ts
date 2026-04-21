/// <reference lib="webworker" />
/**
 * COBRA service worker.
 *
 * Two jobs, one SW (so there's no scope conflict):
 *
 *   1. **Precache** of the built assets (workbox-precaching). The build
 *      step injects the manifest at `self.__WB_MANIFEST`.
 *   2. **COOP / COEP / CORP header injection.** GitHub Pages can't set
 *      these itself; without them, `SharedArrayBuffer` is disabled and
 *      threaded Stockfish won't load. A single fetch listener intercepts
 *      every response and grafts the headers on, after serving from the
 *      precache where applicable.
 */

import { PrecacheController, cleanupOutdatedCaches } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & {
	__WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const precache = new PrecacheController();
precache.addToCacheList(self.__WB_MANIFEST ?? []);

self.addEventListener('install', (event) => {
	event.waitUntil(precache.install(event));
	self.skipWaiting();
});
self.addEventListener('activate', (event) => {
	event.waitUntil(precache.activate(event));
	cleanupOutdatedCaches();
	event.waitUntil(self.clients.claim());
});

/**
 * Cross-origin-isolation headers. Static-host deployments (GH Pages)
 * can't set these on the server, so we synthesise them here for every
 * same-origin response. `credentialless` (not `require-corp`) is the
 * important bit: it still gives us SharedArrayBuffer, but lets
 * cross-origin requests (Lichess API, masters explorer, Stockfish NNUE
 * CDNs) succeed without a CORP header on the upstream. With
 * `require-corp` those requests would fail at the network layer
 * because servers like lichess.org don't set CORP.
 */
function addIsolationHeaders(response: Response): Response {
	if (!response || response.status === 0 || response.type === 'opaque') return response;
	const headers = new Headers(response.headers);
	headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
	headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

	// Let cross-origin requests fly through untouched. We only need to
	// inject headers on our own responses to flip the page into
	// cross-origin-isolated mode; intercepting e.g. explorer.lichess.ovh
	// fetches just wraps them for no benefit and risks breaking them.
	const isSameOrigin = new URL(req.url).origin === self.location.origin;
	if (!isSameOrigin) return;

	event.respondWith(
		(async () => {
			// Precache hit? Serve from cache. Otherwise fall back to network.
			const precacheMatch = await precache.matchPrecache(req.url).catch(() => undefined);
			if (precacheMatch) return addIsolationHeaders(precacheMatch);
			try {
				const fresh = await fetch(req);
				return addIsolationHeaders(fresh);
			} catch (e) {
				// Offline fallback: for navigation requests, try the app shell
				// (index.html) from precache.
				if (req.mode === 'navigate') {
					const shell = await precache.matchPrecache('/').catch(() => undefined);
					if (shell) return addIsolationHeaders(shell);
				}
				throw e;
			}
		})()
	);
});

<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto, afterNavigate } from '$app/navigation';
	import { base, resolve } from '$app/paths';
	import { Menu, X, Moon, Sun } from 'lucide-svelte';
	import { ModeWatcher, mode, toggleMode } from 'mode-watcher';
	import { ConfirmDialog, Toaster, toast } from '$lib/ui';
	import ScanProgressBar from '$lib/dossier/ScanProgressBar.svelte';
	import BaselineProgressBar from '$lib/dossier/BaselineProgressBar.svelte';
	import SyncStatusPill from '$lib/sync/SyncStatusPill.svelte';
	import SyncConflictModal from '$lib/sync/SyncConflictModal.svelte';
	import UpdateBanner from '$lib/pwa/UpdateBanner.svelte';
	import { sync } from '$lib/sync/syncStore.svelte';
	import { getSettings, saveSettings } from '$lib/storage/settings';
	import { scanAllAccounts, collectAccountsFromSettings } from '$lib/lichess/mistakeScan';
	import { applySoundSettings } from '$lib/ui/sounds';
	import { getEngine } from '$lib/stockfish/engine';
	import { appearance } from '$lib/board/appearance.svelte';
	import { openExternal, isExternalHttpUrl } from '$lib/platform/openExternal';
	import { TAURI_DEEP_LINK_SCHEME } from '$lib/lichess/oauth';
	import pkg from '../../package.json';

	const appVersion = pkg.version;

	let { children } = $props();

	const navItems = [
		{
			href: `${base}/library`,
			label: 'Library',
			match: (p: string) => p.startsWith('/library') || p.startsWith('/repertoire')
		},
		{
			href: `${base}/walkthrough`,
			label: 'Walkthrough',
			match: (p: string) => p.startsWith('/walkthrough')
		},
		{
			href: `${base}/mistakes`,
			label: 'Mistakes',
			match: (p: string) => p.startsWith('/mistakes')
		},
		{
			href: `${base}/dossier`,
			label: 'Dossier',
			match: (p: string) => p.startsWith('/dossier')
		},
		{
			href: `${base}/opponent-prep`,
			label: 'Opponent',
			match: (p: string) => p.startsWith('/opponent-prep')
		},
		{ href: `${base}/settings`, label: 'Settings', match: (p: string) => p.startsWith('/settings') }
	];

	// `page.url.pathname` includes the base path when deployed under a subpath
	// (e.g. '/COBRA/library'). Strip it so our nav-match checks stay
	// base-agnostic.
	const path = $derived(page.url.pathname.slice(base.length) || '/');
	// GoatCounter SPA pageviews (web + Tauri). The count.js snippet in app.html
	// records one hit on initial load; SvelteKit client navigations don't reload
	// the page, so we count them manually here. Skip the first `enter` navigation
	// to avoid double-counting that initial load, and guard on `window.goatcounter`
	// since the CDN script is async and may not have loaded yet.
	afterNavigate((nav) => {
		if (nav.type === 'enter') return;
		const gc = (
			window as unknown as {
				goatcounter?: { count?: (opts: { path: string }) => void };
			}
		).goatcounter;
		gc?.count?.({ path: location.pathname + location.search });
	});

	// Mobile hamburger menu. Open drawer closes on route change.
	let menuOpen = $state(false);
	$effect(() => {
		// Close on navigation.
		void path;
		menuOpen = false;
	});

	// Escape-to-close keeps keyboard users from being trapped in an open
	// drawer. When the drawer is open we also don't want background scroll
	// to happen behind the overlay.
	function onWindowKey(e: KeyboardEvent) {
		if (menuOpen && e.key === 'Escape') {
			e.preventDefault();
			menuOpen = false;
		}
	}

	$effect(() => {
		if (typeof document === 'undefined') return;
		const prev = document.body.style.overflow;
		if (menuOpen) document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = prev;
		};
	});

	const AUTOSCAN_INTERVAL_MS = 60 * 60 * 1000; // once per hour
	let autoscanTriggered = false;

	// Subscribe once to the engine's error channel so init failures and
	// search timeouts surface as toasts instead of being swallowed by the
	// `.catch(() => undefined)` callers scatter around. `stderr` is the
	// emscripten log firehose — too noisy to render. The error events use a
	// dedup key so a long scan that times out repeatedly doesn't tile the
	// screen with notices.
	$effect(() => {
		const engine = getEngine();
		const off = engine.onError((e) => {
			if (e.kind === 'stderr') return;
			if (e.kind === 'init') {
				toast.error('Engine unavailable', {
					body: e.message,
					dedupKey: 'engine-init'
				});
			} else if (e.kind === 'timeout' || e.kind === 'no-info') {
				toast.warn('Engine slow to respond', {
					body: e.message,
					dedupKey: `engine-${e.kind}`
				});
			} else if (e.kind === 'handler') {
				toast.warn('Engine event handler error', {
					body: e.message,
					dedupKey: 'engine-handler'
				});
			}
		});
		return off;
	});

	// Re-apply board / piece-set choices to <html> whenever they change.
	// One effect, lives for the session — the layout never unmounts.
	$effect(() => {
		appearance.apply();
	});

	// On-device diagnostic for the cross-origin-isolation status. SAB is only
	// exposed when the document is COI; if it isn't, threaded Stockfish
	// won't load. Logging this once per session into the overlay (and
	// probing the actual response headers Tauri's asset server emits)
	// lets us tell, on a packaged Android build, whether COOP/COEP are
	// reaching the WebView at all — without needing chrome://inspect.
	$effect(() => {
		if (typeof window === 'undefined') return;
		const diag = (window as unknown as { __cobraDiag?: { log?: (m: string) => void } }).__cobraDiag;
		const log = (m: string) => diag?.log?.(m);
		log(
			`coi=${window.crossOriginIsolated} sab=${typeof SharedArrayBuffer !== 'undefined'} ` +
				`origin=${window.location.origin}`
		);
		// Sniff the actual HTTP headers on a same-origin asset. If
		// `coi=false` here but COOP/COEP land in the response, then the
		// WebView is ignoring them (often a scheme/secure-context issue).
		// If they're absent, the asset server isn't injecting them and we
		// need to fix that layer.
		void fetch(window.location.href, { method: 'GET', cache: 'no-store' })
			.then((r) => {
				log(
					`headers: COOP=${r.headers.get('Cross-Origin-Opener-Policy')} ` +
						`COEP=${r.headers.get('Cross-Origin-Embedder-Policy')} ` +
						`CORP=${r.headers.get('Cross-Origin-Resource-Policy')}`
				);
			})
			.catch((e) => log(`header-probe failed: ${e instanceof Error ? e.message : e}`));
	});

	// Tauri-only: route external link clicks to the OS browser instead of
	// the in-app WebView. Without this, `<a target="_blank" href="https://…">`
	// either spawns a sandboxed webview (no saved passwords / cookies) or
	// navigates the main webview off the app entirely. The opener plugin
	// hands the URL to the user's real browser. Web builds keep the native
	// `<a>` behaviour the browser already implements correctly.
	$effect(() => {
		if (typeof window === 'undefined') return;
		// Cheap synchronous check — `isTauri()` from @tauri-apps/api/core
		// just looks for `__TAURI_INTERNALS__` on window. Skip the import
		// to keep this hot-path tiny.
		const inTauri = '__TAURI_INTERNALS__' in window || '__TAURI_METADATA__' in window;
		if (!inTauri) return;
		function onClick(e: MouseEvent) {
			// Let modifier-clicks (cmd/ctrl/middle-click "open in new tab")
			// fall through to default handling — those users know what they
			// want; we shouldn't second-guess.
			if (e.defaultPrevented) return;
			if (e.button !== 0) return;
			if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			const target = e.target instanceof Element ? e.target : null;
			const a = target?.closest('a');
			if (!a) return;
			const href = a.getAttribute('href');
			if (!href) return;
			if (!isExternalHttpUrl(href)) return;
			e.preventDefault();
			void openExternal(new URL(href, window.location.href).href);
		}
		document.addEventListener('click', onClick);
		return () => document.removeEventListener('click', onClick);
	});

	// Tauri-only: receive deep-links from the OS and route the SvelteKit
	// app to the matching internal page. Currently the only scheme we
	// handle is the Lichess OAuth callback — the user authorises in their
	// system browser, Lichess redirects to
	// `io.github.eiontusk.cobra://auth/lichess/callback?code=…&state=…`,
	// the OS hands the URL to us, and we hop the router onto the existing
	// /auth/lichess/callback page so it can finish the token exchange and
	// surface success/error.
	$effect(() => {
		if (typeof window === 'undefined') return;
		const inTauri = '__TAURI_INTERNALS__' in window || '__TAURI_METADATA__' in window;
		if (!inTauri) return;

		// Trace via the diagnostic overlay. `__cobraDiag` is set up by the
		// inline script in app.html; entries persist across crashes / cold
		// restarts via localStorage, which is essential here because an
		// incoming deep-link intent can relaunch the process and erase the
		// in-memory log. Defensive `?.` chain so a stripped overlay (web
		// build, future refactor) doesn't make this throw.
		const trace = (msg: string) => {
			try {
				(window as unknown as { __cobraDiag?: { log?: (m: string) => void } }).__cobraDiag?.log?.(
					msg
				);
			} catch {
				/* ignore */
			}
		};

		trace('deep-link effect armed');

		let cancelled = false;
		let unlisten: (() => void) | undefined;

		function dispatch(rawUrls: string[] | null | undefined, source: string) {
			trace(`dispatch[${source}] urls=${rawUrls ? rawUrls.length : 0}`);
			if (!rawUrls) return;
			for (const raw of rawUrls) {
				trace(`dispatch[${source}] raw=${raw}`);
				let parsed: URL;
				try {
					parsed = new URL(raw);
				} catch (e) {
					trace(`dispatch[${source}] URL parse threw: ${e instanceof Error ? e.message : e}`);
					continue;
				}
				if (parsed.protocol !== `${TAURI_DEEP_LINK_SCHEME}:`) {
					trace(`dispatch[${source}] skip — protocol=${parsed.protocol}`);
					continue;
				}
				// `new URL("<scheme>://auth/lichess/callback?…")` parses host="auth"
				// and pathname="/lichess/callback". Stitch them back together
				// for matching so the path is whole regardless of how the OS
				// formatted the incoming URL.
				const fullPath = `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
				trace(`dispatch[${source}] fullPath=${fullPath}`);
				if (fullPath !== 'auth/lichess/callback') continue;
				const target = resolve('/auth/lichess/callback') + parsed.search;
				trace(`dispatch[${source}] navigating → ${target.slice(0, 80)}`);
				try {
					// Reuse the existing callback page so users see the same
					// "Linking your account…" UX whether they came from web or
					// the deep-link. The eslint rule wants the whole string to
					// be `resolve(...)`-prefixed; we *are* resolving the route,
					// then tacking on an arbitrary query string the OS handed us.
					// eslint-disable-next-line svelte/no-navigation-without-resolve
					void goto(target);
				} catch (e) {
					trace(`dispatch[${source}] goto threw: ${e instanceof Error ? e.message : e}`);
				}
			}
		}

		(async () => {
			try {
				trace('importing @tauri-apps/plugin-deep-link');
				const dl = await import('@tauri-apps/plugin-deep-link');
				trace('deep-link plugin imported');
				// Cold-start: the app may have just been launched *by* the
				// callback URL, in which case the URL is queued from before
				// our listener was registered.
				try {
					trace('calling getCurrent()');
					const startUrls = await dl.getCurrent();
					trace(`getCurrent() returned ${startUrls ? startUrls.length : 'null'} url(s)`);
					if (!cancelled) dispatch(startUrls, 'getCurrent');
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					trace(`getCurrent threw: ${msg}`);
					console.warn('[cobra] deep-link getCurrent failed:', e);
				}
				if (cancelled) return;
				trace('registering onOpenUrl listener');
				const off = await dl.onOpenUrl((urls) => {
					trace(`onOpenUrl fired: ${urls ? urls.length : 0} url(s)`);
					dispatch(urls, 'onOpenUrl');
				});
				trace('onOpenUrl listener registered');
				if (cancelled) {
					off();
				} else {
					unlisten = off;
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				trace(`deep-link plugin unavailable: ${msg}`);
				console.warn('[cobra] deep-link plugin unavailable:', e);
			}
		})();

		return () => {
			cancelled = true;
			if (unlisten) unlisten();
		};
	});

	onMount(async () => {
		// Hourly background mistake scan: fires once per session if the last
		// scan is stale and a Lichess account is connected. Silent — results
		// show up on the /mistakes page and the home banner on next visit.
		if (autoscanTriggered) return;
		autoscanTriggered = true;
		try {
			const s = await getSettings();
			applySoundSettings(s);
			appearance.setBoard(s.boardTheme);
			appearance.setPieces(s.pieceSet);
			// Sync init + opportunistic background pull. Both no-op when sync
			// is disabled or unconfigured.
			void sync
				.init()
				.then(() => sync.maybePullOnLoad())
				.catch((e) => {
					console.warn('[cobra] sync init failed:', e);
				});
			const lastScan = s.lastMistakeScanAt ?? 0;
			if (Date.now() - lastScan < AUTOSCAN_INTERVAL_MS) return;
			if (collectAccountsFromSettings(s).length === 0) return;
			// Fire and forget. Keep the work small per-account (20 games) —
			// with N accounts this is still bounded and runs in series.
			void scanAllAccounts(s, { maxGamesPerAccount: 20, rated: true })
				.then(async () => {
					const latest = await getSettings();
					const next = { ...latest, lastMistakeScanAt: Date.now() };
					await saveSettings(JSON.parse(JSON.stringify(next)));
				})
				.catch((e) => {
					// Background scan failures stay quiet — a transient Lichess
					// outage shouldn't pop a toast every page load. But a single
					// per-session warn lets the user notice config issues
					// (revoked token, deleted account) instead of wondering why
					// /mistakes isn't refreshing. Dedup key keeps repeats off
					// screen even if multiple scans are in flight.
					const detail = e instanceof Error ? e.message : String(e);
					console.warn('[cobra] autoscan failed:', e);
					toast.warn('Background mistake scan ran into trouble', {
						body: `${detail}. Open /mistakes to retry manually if you were expecting fresh data.`,
						dedupKey: 'autoscan-fail'
					});
				});
		} catch {
			/* ignore */
		}
	});
</script>

<svelte:head>
	<title>COBRA</title>
	<meta name="theme-color" content={mode.current === 'light' ? '#fbf7ec' : '#0b0a09'} />
	<link rel="icon" type="image/svg+xml" href="{base}/icon.svg" />
	<link rel="apple-touch-icon" href="{base}/icon.svg" />
	<!--
		Nudge the page to reload once after the PWA service worker takes
		control on first load. The SW also injects COOP/COEP headers for
		cross-origin-isolation (so SharedArrayBuffer / threaded Stockfish
		work on GH Pages), and those headers only apply to responses that
		go *through* the SW — which doesn't happen until the first time
		the page is controlled.

		Skipped in Tauri (desktop and mobile): the PWA isn't registered
		there (see vite.config.ts), so `serviceWorker.ready` would resolve
		never. On Android Tauri WebView the URL is `http://tauri.localhost`,
		which Chromium refuses to register a SW against, so this script
		would also surface a noisy console.error in the diagnostic overlay.
	-->
	<script>
		(function () {
			if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
			if ('__TAURI_INTERNALS__' in window || '__TAURI_METADATA__' in window) return;
			if (window.crossOriginIsolated) return;
			if (navigator.serviceWorker.controller) return;
			navigator.serviceWorker.ready.then(function () {
				if (!navigator.serviceWorker.controller) return;
				location.reload();
			});
		})();
	</script>
</svelte:head>

<svelte:window on:keydown={onWindowKey} />

<div class="flex min-h-screen flex-col">
	<header
		class="safe-pad-top sticky top-0 z-40 border-b border-[var(--color-ink-800)] bg-[var(--color-ink-950)]/85 backdrop-blur-md"
	>
		<div class="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:gap-8 sm:px-6">
			<!-- Mobile hamburger — visible only below md, toggles the drawer. -->
			<button
				type="button"
				class="flex size-9 shrink-0 items-center justify-center rounded-[3px] text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] md:hidden"
				aria-label={menuOpen ? 'Close menu' : 'Open menu'}
				aria-expanded={menuOpen}
				aria-controls="cobra-mobile-nav"
				onclick={() => (menuOpen = !menuOpen)}
			>
				{#if menuOpen}
					<X class="size-5" />
				{:else}
					<Menu class="size-5" />
				{/if}
			</button>

			<a href={resolve('/')} class="group flex shrink-0 items-center gap-2" aria-label="COBRA home">
				<span
					class="font-serif text-2xl leading-none text-[var(--color-brass-300)] transition-colors group-hover:text-[var(--color-brass-200)]"
					>♞</span
				>
				<span
					class="font-serif text-lg leading-none tracking-[0.04em] text-[var(--color-parchment-50)]"
				>
					COBRA
				</span>
			</a>

			<!-- Desktop horizontal nav (md and up). Mobile users see the drawer. -->
			<nav class="-mb-px hidden min-w-0 flex-1 items-center gap-5 md:flex" aria-label="Main">
				{#each navItems as item (item.href)}
					{@const active = item.match(path)}
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<a
						href={item.href}
						class="eyebrow relative flex h-14 shrink-0 items-center transition-colors hover:text-[var(--color-parchment-100)]"
						class:!text-[var(--color-parchment-50)]={active}
						aria-current={active ? 'page' : undefined}
					>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{item.label}
						{#if active}
							<span class="absolute inset-x-0 -bottom-px h-[2px] bg-[var(--color-brass-300)]"
							></span>
						{/if}
					</a>
				{/each}
			</nav>

			<!-- Spacer on mobile so the New button sticks to the right. -->
			<div class="flex-1 md:hidden"></div>

			<!-- Sync status pill. Self-hides when sync is disabled. -->
			<SyncStatusPill />

			<!-- Theme toggle. Sits on the right of the header in all breakpoints. -->
			<button
				type="button"
				class="flex size-9 shrink-0 items-center justify-center rounded-[3px] text-[var(--color-parchment-300)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)]"
				onclick={toggleMode}
				aria-label={mode.current === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
				title={mode.current === 'light' ? 'Switch to dark' : 'Switch to light'}
			>
				{#if mode.current === 'light'}
					<Moon class="size-4" />
				{:else}
					<Sun class="size-4" />
				{/if}
			</button>
		</div>

		<!-- Mobile drawer. Slides down under the header; backdrop closes it. -->
		{#if menuOpen}
			<button
				type="button"
				aria-label="Close menu"
				class="safe-top-header fixed inset-0 z-30 bg-[var(--color-ink-950)]/60 backdrop-blur-sm md:hidden"
				onclick={() => (menuOpen = false)}
			></button>
			<nav
				id="cobra-mobile-nav"
				class="ot-fade safe-top-header fixed inset-x-0 z-40 border-b border-[var(--color-ink-800)] bg-[var(--color-ink-950)] shadow-[0_12px_24px_-8px_rgba(0,0,0,0.6)] md:hidden"
				aria-label="Mobile"
			>
				<ul class="flex flex-col py-2">
					{#each navItems as item (item.href)}
						{@const active = item.match(path)}
						<li>
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={item.href}
								onclick={() => (menuOpen = false)}
								class="flex items-center gap-3 border-l-2 px-5 py-3 font-serif text-lg transition-colors hover:bg-[var(--color-ink-900)]"
								class:border-transparent={!active}
								class:text-[var(--color-parchment-300)]={!active}
								class:border-[var(--color-brass-300)]={active}
								class:text-[var(--color-parchment-50)]={active}
								class:bg-[var(--color-ink-900)]={active}
								aria-current={active ? 'page' : undefined}
							>
								{item.label}
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						</li>
					{/each}
				</ul>
			</nav>
		{/if}
	</header>

	<main class="ot-fade flex-1">
		{@render children()}
	</main>

	<footer class="safe-pad-bottom mt-auto border-t border-[var(--color-ink-800)]">
		<div
			class="mx-auto flex max-w-7xl flex-col items-start justify-between gap-3 px-4 py-5 text-xs text-[var(--color-parchment-500)] sm:flex-row sm:items-center sm:gap-4 sm:px-6"
		>
			<span class="font-serif leading-snug italic">
				<strong class="font-sans tracking-wider text-[var(--color-parchment-300)] not-italic"
					>COBRA</strong
				>
				— Chess Opening Builder and Repertoire Analyzer.
			</span>
			<span class="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono">
				<a
					href="https://github.com/EIonTusk/COBRA"
					target="_blank"
					rel="noopener"
					class="inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]"
					aria-label="COBRA on GitHub"
				>
					<svg viewBox="0 0 24 24" fill="currentColor" class="size-3.5" aria-hidden="true">
						<path
							d="M12 .5C5.73.5.58 5.65.58 11.92c0 5.01 3.29 9.26 7.85 10.77.57.11.78-.25.78-.55 0-.27-.01-1.18-.02-2.14-3.19.69-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.27-5.23-5.66 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18.91-.25 1.89-.38 2.87-.39.97.01 1.95.14 2.87.39 2.19-1.49 3.15-1.18 3.15-1.18.62 1.58.23 2.75.11 3.04.73.8 1.18 1.83 1.18 3.08 0 4.4-2.69 5.37-5.25 5.65.41.36.78 1.05.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .3.2.67.79.55 4.56-1.51 7.84-5.76 7.84-10.77C23.42 5.65 18.27.5 12 .5z"
						/>
					</svg>
					GitHub
				</a>
				<a
					href="https://www.buymeacoffee.com/EIonTusk"
					target="_blank"
					rel="noopener"
					class="inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]"
					aria-label="Support COBRA on Buy Me a Coffee"
				>
					<span aria-hidden="true">☕</span>
					Support
				</a>
				<span>AGPL-3.0 · v{appVersion}</span>
			</span>
		</div>
	</footer>
</div>

<ScanProgressBar />

<BaselineProgressBar />

<ConfirmDialog />

<SyncConflictModal />

<UpdateBanner />

<Toaster />

<!--
	ModeWatcher: persists the chosen mode in localStorage, applies the
	`light` class to <html> when in light mode, and injects a pre-hydration
	script to avoid a flash of the wrong theme on first paint. Default
	remains dark — only users who actively toggle land on the light theme.
	`track={false}` keeps the app on whichever mode the user picked instead
	of following the OS theme every time it flips.
-->
<ModeWatcher defaultMode="dark" track={false} lightClassNames={['light']} />

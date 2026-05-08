<script lang="ts">
	/**
	 * Surfaces a "new version available" notice when a freshly built
	 * service worker has been installed but is still waiting to activate.
	 *
	 * The PWA plugin runs in `prompt` mode (see `vite.config.ts`) and the
	 * service worker no longer calls `skipWaiting()` on install. That
	 * means after a deploy, the browser fetches the new SW, installs it,
	 * and parks it in the `waiting` state. `useRegisterSW` watches that
	 * state via workbox-window and flips `needRefresh` to true; we render
	 * the prompt and, if the user accepts, tell the SW to skip waiting.
	 * The `controlling` event then triggers a page reload so the new
	 * bundle takes over.
	 *
	 * Registration is gated on:
	 *   - `serviceWorker` existing on `navigator` (older WebViews)
	 *   - the page not running inside Tauri (the Android Chromium
	 *     WebView refuses to register a SW against `tauri.localhost`)
	 *
	 * The dynamic import keeps the workbox-window dependency out of the
	 * critical path on first paint and lets non-PWA environments degrade
	 * silently if the virtual module ever fails to resolve.
	 */
	import { onMount } from 'svelte';
	import { Button } from '$lib/ui';
	import { Download, X } from 'lucide-svelte';

	let needRefresh = $state(false);
	let updateSW: ((reload?: boolean) => Promise<void>) | null = $state(null);
	let dismissed = $state(false);

	const visible = $derived(needRefresh && !dismissed && updateSW !== null);

	onMount(() => {
		if (typeof window === 'undefined') return;
		if (!('serviceWorker' in navigator)) return;
		const inTauri = '__TAURI_INTERNALS__' in window || '__TAURI_METADATA__' in window;
		if (inTauri) return;

		let unsub: (() => void) | null = null;
		void (async () => {
			try {
				const mod = await import('virtual:pwa-register/svelte');
				const reg = mod.useRegisterSW({
					onRegisterError(err) {
						console.warn('[cobra] service worker register error:', err);
					}
				});
				updateSW = reg.updateServiceWorker;
				unsub = reg.needRefresh.subscribe((v) => {
					needRefresh = v;
					if (v) dismissed = false;
				});
			} catch (e) {
				console.warn('[cobra] PWA register module unavailable:', e);
			}
		})();

		return () => {
			unsub?.();
		};
	});

	function applyUpdate() {
		if (!updateSW) return;
		void updateSW();
	}
</script>

{#if visible}
	<div
		class="ot-fade safe-pad-bottom pointer-events-none fixed inset-x-0 bottom-0 z-[55] flex justify-center px-3 pb-3 sm:justify-end sm:pr-5 sm:pb-5"
	>
		<div
			role="status"
			aria-live="polite"
			class="ink-panel pointer-events-auto flex w-full max-w-sm items-start gap-3 border-l-2 p-4 shadow-[0_18px_36px_-12px_rgba(0,0,0,0.7)]"
			style="border-left-color: var(--color-brass-300);"
		>
			<Download class="mt-0.5 size-4 shrink-0 text-[var(--color-brass-300)]" aria-hidden="true" />
			<div class="min-w-0 flex-1">
				<div class="font-serif text-sm leading-snug text-[var(--color-parchment-50)]">
					A new version of COBRA is available
				</div>
				<div
					class="mt-0.5 font-serif text-xs leading-snug text-[var(--color-parchment-400)] italic"
				>
					Reload to upgrade — your repertoires and progress stay where they are.
				</div>
				<div class="mt-3 flex gap-2">
					<Button type="button" variant="primary" size="sm" onclick={applyUpdate}>Reload</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onclick={() => {
							dismissed = true;
						}}
					>
						Later
					</Button>
				</div>
			</div>
			<button
				type="button"
				class="-mt-1 -mr-1 flex size-6 shrink-0 items-center justify-center rounded-[3px] text-[var(--color-parchment-500)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)]"
				aria-label="Dismiss update notice"
				onclick={() => {
					dismissed = true;
				}}
			>
				<X class="size-3.5" />
			</button>
		</div>
	</div>
{/if}

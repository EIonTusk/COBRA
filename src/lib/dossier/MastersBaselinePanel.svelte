<script lang="ts">
	/**
	 * Reusable status / fetch / refresh control for the cached masters
	 * baseline. Each dossier subpage that wants a "vs masters" overlay
	 * mounts this once, binds `baseline`, and reads from it. The cached
	 * baseline is global (single IDB row) so the first page that fetches
	 * primes every other module.
	 */
	import { onMount } from 'svelte';

	import { buildMastersBaseline, targetsHash, type MastersFetchProgress } from './mastersBaseline';
	import {
		loadMastersBaseline,
		saveMastersBaseline,
		clearMastersBaseline,
		type LoadedMastersBaseline
	} from '$lib/storage/mastersBaseline';
	import { getSettings, effectiveLichessToken } from '$lib/storage/settings';
	import type { DossierScanResult } from './scan';

	let {
		result,
		baseline = $bindable()
	}: {
		result: DossierScanResult | null;
		baseline: LoadedMastersBaseline | null;
	} = $props();

	let fetching = $state(false);
	let progress = $state<MastersFetchProgress | null>(null);
	let error = $state<string | null>(null);
	let token = $state<string>('');

	onMount(async () => {
		if (!baseline) baseline = await loadMastersBaseline();
		const settings = await getSettings();
		token = effectiveLichessToken(settings);
	});

	async function fetchMasters() {
		if (!result || fetching) return;
		if (!token) {
			error = 'A Lichess API token is required for the masters DB. Add one in Settings → Lichess.';
			return;
		}
		fetching = true;
		error = null;
		progress = null;
		try {
			const built = await buildMastersBaseline(result.classified, {
				token,
				onProgress: (p) => {
					progress = p;
				}
			});
			const hash = targetsHash(result.classified);
			await saveMastersBaseline(hash, { games: built.games, coverage: built.coverage });
			baseline = {
				fetchedAt: built.fetchedAt,
				targetsHash: hash,
				games: built.games,
				coverage: built.coverage
			};
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			fetching = false;
			progress = null;
		}
	}

	async function refresh() {
		await clearMastersBaseline();
		baseline = null;
		await fetchMasters();
	}

	function formatTimeAgo(ts: number): string {
		const diffMs = Date.now() - ts;
		const min = Math.floor(diffMs / 60_000);
		if (min < 1) return 'just now';
		if (min < 60) return `${min} min ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr} hr ago`;
		const day = Math.floor(hr / 24);
		return `${day} day${day === 1 ? '' : 's'} ago`;
	}
</script>

<div
	class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2.5 text-xs"
>
	{#if fetching}
		<div class="flex items-baseline justify-between gap-3">
			<span class="text-[var(--color-parchment-200)]">
				Fetching masters baseline…
				{#if progress}
					<span class="font-mono text-[var(--color-parchment-400)]">
						{progress.done}/{progress.total} families · {progress.gamesFetched} games
					</span>
				{/if}
			</span>
		</div>
		{#if progress?.currentFamily}
			<div class="mt-1 font-mono text-[10px] text-[var(--color-parchment-500)]">
				Current: {progress.currentFamily} ({progress.currentColor})
			</div>
		{/if}
	{:else if baseline}
		<div class="flex flex-wrap items-baseline justify-between gap-3">
			<span class="text-[var(--color-parchment-300)]">
				Masters baseline:
				<span class="font-mono text-[var(--color-parchment-100)]">{baseline.games.length}</span>
				games across
				<span class="font-mono text-[var(--color-parchment-100)]">{baseline.coverage.length}</span>
				openings · fetched {formatTimeAgo(baseline.fetchedAt)}
			</span>
			<button
				type="button"
				class="text-[var(--color-parchment-400)] underline hover:text-[var(--color-parchment-200)] disabled:opacity-50"
				onclick={refresh}
				disabled={!token}
			>
				refresh
			</button>
		</div>
	{:else}
		<div class="flex flex-wrap items-baseline justify-between gap-3">
			<span class="text-[var(--color-parchment-300)]">
				Pull master games matching your repertoire as a directional reference (≈1 min, requires
				Lichess token).
			</span>
			<button
				type="button"
				class="rounded border border-[var(--color-brass-300)]/40 bg-[var(--color-brass-300)]/10 px-3 py-1 text-[var(--color-parchment-100)] hover:bg-[var(--color-brass-300)]/20 disabled:opacity-50"
				onclick={fetchMasters}
				disabled={!token}
			>
				Fetch baseline
			</button>
		</div>
		{#if !token}
			<div class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
				Add a Lichess personal API token in Settings to enable.
			</div>
		{/if}
	{/if}
	{#if error}
		<div class="mt-1.5 text-amber-300">{error}</div>
	{/if}
</div>

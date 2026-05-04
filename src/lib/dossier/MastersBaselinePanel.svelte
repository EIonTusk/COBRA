<script lang="ts">
	/**
	 * Reusable status / fetch / refresh control for the cached masters
	 * baseline. Each dossier subpage that wants a "vs masters" overlay
	 * mounts this once, binds `baseline`, and reads from it. The cached
	 * baseline is global (single IDB row) so the first page that fetches
	 * primes every other module.
	 *
	 * The "Configure" expander lets the user pick which (family, colour)
	 * buckets to fetch and how many master games per bucket. Defaults
	 * mirror the auto-extract path so users who don't configure get the
	 * same behaviour as before.
	 */
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';

	import {
		buildMastersBaseline,
		enumerateMastersCandidates,
		targetsHash,
		type CandidateTarget,
		type MastersFetchProgress,
		type Target
	} from './mastersBaseline';
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

	let configuring = $state(false);
	// Per-target game count. Lichess masters explorer caps `topGames` at
	// 15; clamp to that range. Default 12 matches the prior auto-fetch.
	let perTarget = $state(12);
	const PER_TARGET_MIN = 3;
	const PER_TARGET_MAX = 15;
	// User overrides on the auto-included default — only entries the user
	// has actually toggled live here. The effective `selected` map is
	// derived (auto default merged with overrides) so a fresh scan
	// auto-resets the selection without us writing into reactive state
	// from an effect.
	const userOverrides = new SvelteMap<string, boolean>();

	const candidates = $derived<CandidateTarget[]>(
		result ? enumerateMastersCandidates(result.classified) : []
	);

	function candidateKey(c: { family: string; color: string }): string {
		return `${c.color}|${c.family}`;
	}

	const selected = $derived.by(() => {
		const map = new SvelteMap<string, boolean>();
		for (const c of candidates) {
			const k = candidateKey(c);
			const override = userOverrides.get(k);
			map.set(k, override !== undefined ? override : c.autoIncluded);
		}
		return map;
	});

	const selectedCount = $derived(Array.from(selected.values()).filter((v) => v).length);
	const selectedGameEstimate = $derived(selectedCount * perTarget);

	onMount(async () => {
		if (!baseline) baseline = await loadMastersBaseline();
		const settings = await getSettings();
		token = effectiveLichessToken(settings);
	});

	function pickedTargets(): Target[] {
		const out: Target[] = [];
		for (const c of candidates) {
			if (selected.get(candidateKey(c))) {
				out.push({
					family: c.family,
					color: c.color,
					userGames: c.userGames,
					canonicalFen: c.canonicalFen
				});
			}
		}
		return out;
	}

	async function fetchMasters(opts: { useSelection: boolean } = { useSelection: false }) {
		if (!result || fetching) return;
		if (!token) {
			error = 'A Lichess API token is required for the masters DB. Add one in Settings → Lichess.';
			return;
		}
		fetching = true;
		error = null;
		progress = null;
		try {
			const targets = opts.useSelection ? pickedTargets() : undefined;
			if (opts.useSelection && (!targets || targets.length === 0)) {
				error = 'Pick at least one (opening × colour) bucket to fetch.';
				fetching = false;
				return;
			}
			const built = await buildMastersBaseline(result.classified, {
				token,
				perTarget,
				targets,
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
			configuring = false;
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

	function selectAll() {
		for (const c of candidates) userOverrides.set(candidateKey(c), true);
	}
	function selectNone() {
		for (const c of candidates) userOverrides.set(candidateKey(c), false);
	}
	function selectAuto() {
		// Clear all overrides — `selected` falls back to candidate defaults.
		userOverrides.clear();
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
			<div class="flex gap-3">
				<button
					type="button"
					class="text-[var(--color-parchment-400)] underline hover:text-[var(--color-parchment-200)]"
					onclick={() => (configuring = !configuring)}
				>
					{configuring ? 'cancel' : 'configure'}
				</button>
				<button
					type="button"
					class="text-[var(--color-parchment-400)] underline hover:text-[var(--color-parchment-200)] disabled:opacity-50"
					onclick={refresh}
					disabled={!token}
				>
					refresh
				</button>
			</div>
		</div>
	{:else}
		<div class="flex flex-wrap items-baseline justify-between gap-3">
			<span class="text-[var(--color-parchment-300)]">
				Pull master games matching your repertoire as a directional reference (≈1 min, requires
				Lichess token).
			</span>
			<div class="flex gap-3">
				<button
					type="button"
					class="text-[var(--color-parchment-400)] underline hover:text-[var(--color-parchment-200)]"
					onclick={() => (configuring = !configuring)}
				>
					{configuring ? 'cancel' : 'configure'}
				</button>
				<button
					type="button"
					class="rounded border border-[var(--color-brass-300)]/40 bg-[var(--color-brass-300)]/10 px-3 py-1 text-[var(--color-parchment-100)] hover:bg-[var(--color-brass-300)]/20 disabled:opacity-50"
					onclick={() => fetchMasters()}
					disabled={!token}
				>
					Fetch baseline
				</button>
			</div>
		</div>
		{#if !token}
			<div class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
				Add a Lichess personal API token in Settings to enable.
			</div>
		{/if}
	{/if}

	{#if configuring && !fetching}
		<div class="mt-3 border-t border-[var(--color-ink-800)] pt-3">
			{#if candidates.length === 0}
				<div class="text-[var(--color-parchment-500)]">
					No openings with at least 4 user games yet — run a larger scan first.
				</div>
			{:else}
				<div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
					<div class="text-[10px] tracking-wider text-[var(--color-brass-300)] uppercase">
						Pick (opening × colour) buckets
					</div>
					<div class="flex gap-2 text-[10px] text-[var(--color-parchment-500)]">
						<button
							type="button"
							class="underline hover:text-[var(--color-parchment-200)]"
							onclick={selectAuto}>auto</button
						>
						<button
							type="button"
							class="underline hover:text-[var(--color-parchment-200)]"
							onclick={selectAll}>all</button
						>
						<button
							type="button"
							class="underline hover:text-[var(--color-parchment-200)]"
							onclick={selectNone}>none</button
						>
					</div>
				</div>

				<ul class="grid max-h-64 gap-1 overflow-y-auto pr-1">
					{#each candidates as c (candidateKey(c))}
						{@const k = candidateKey(c)}
						<li class="flex items-center gap-2">
							<input
								type="checkbox"
								id="masters-pick-{k}"
								checked={selected.get(k) ?? false}
								onchange={(e) => {
									userOverrides.set(k, (e.target as HTMLInputElement).checked);
								}}
							/>
							<label
								for="masters-pick-{k}"
								class="flex flex-1 cursor-pointer items-baseline justify-between gap-2"
							>
								<span class="text-[var(--color-parchment-200)]">
									{c.family}
									<span
										class="ml-1 font-mono text-[9px] tracking-wider text-[var(--color-parchment-500)] uppercase"
									>
										{c.color}
									</span>
									{#if !c.autoIncluded}
										<span
											class="ml-1 font-mono text-[9px] text-[var(--color-parchment-500)]"
											title="One-sided faced — opponent's choice; auto-fetch skips this by default"
										>
											(faced)
										</span>
									{/if}
								</span>
								<span class="font-mono text-[var(--color-parchment-400)]">{c.userGames}g</span>
							</label>
						</li>
					{/each}
				</ul>

				<div class="mt-3 flex flex-wrap items-baseline justify-between gap-3">
					<label class="flex items-baseline gap-2 text-[var(--color-parchment-300)]">
						<span>Games per bucket:</span>
						<input
							type="number"
							min={PER_TARGET_MIN}
							max={PER_TARGET_MAX}
							class="w-14 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-1.5 py-0.5 font-mono text-[var(--color-parchment-100)]"
							bind:value={perTarget}
							onblur={() => {
								if (!Number.isFinite(perTarget)) perTarget = 12;
								perTarget = Math.max(
									PER_TARGET_MIN,
									Math.min(PER_TARGET_MAX, Math.round(perTarget))
								);
							}}
						/>
						<span class="font-mono text-[10px] text-[var(--color-parchment-500)]">
							max {PER_TARGET_MAX}
						</span>
					</label>
					<div class="font-mono text-[10px] text-[var(--color-parchment-500)]">
						{selectedCount} / {candidates.length} selected · ≈{selectedGameEstimate} games
					</div>
				</div>

				<div class="mt-3 flex justify-end">
					<button
						type="button"
						class="rounded border border-[var(--color-brass-300)]/40 bg-[var(--color-brass-300)]/10 px-3 py-1 text-[var(--color-parchment-100)] hover:bg-[var(--color-brass-300)]/20 disabled:opacity-50"
						onclick={() => fetchMasters({ useSelection: true })}
						disabled={!token || selectedCount === 0}
					>
						Fetch {selectedCount} bucket{selectedCount === 1 ? '' : 's'}
					</button>
				</div>
			{/if}
		</div>
	{/if}

	{#if error}
		<div class="mt-1.5 text-amber-300">{error}</div>
	{/if}
</div>

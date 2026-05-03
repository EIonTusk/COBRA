<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import MastersBaselinePanel from '$lib/dossier/MastersBaselinePanel.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import {
		analyseStructureTaste,
		structureLabel,
		type Structure,
		type StructureBucket
	} from '$lib/dossier/structureTaste';
	import type { DossierScanResult } from '$lib/dossier/scan';
	import type { LoadedMastersBaseline } from '$lib/storage/mastersBaseline';

	const MASTERS_THIN_SAMPLE = 10;

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);
	let mastersBaseline = $state<LoadedMastersBaseline | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(
		result
			? analyseStructureTaste(
					result.classified,
					mastersBaseline?.games.length ? { comparison: mastersBaseline.games } : {}
				)
			: null
	);

	const mastersByStructure = $derived.by(() => {
		const map = new SvelteMap<Structure, StructureBucket>();
		const rows = summary?.comparisonByStructure;
		if (!rows) return map;
		for (const b of rows) map.set(b.key, b);
		return map;
	});

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}

	function tintForWinRate(rate: number, baseline: number): string {
		const delta = rate - baseline;
		if (delta > 0.05) return 'text-emerald-400';
		if (delta < -0.05) return 'text-amber-300';
		return 'text-[var(--color-parchment-300)]';
	}

	function tintForShareDelta(delta: number): string {
		if (delta > 0.05) return 'text-emerald-400';
		if (delta < -0.05) return 'text-amber-300';
		return 'text-[var(--color-parchment-500)]';
	}
</script>

<DossierSubpageShell
	title="Structure taste"
	subtitle="Which middlegame pawn structures your games pass through — and how you score in each. Snapshot taken at the first middlegame move of every scanned game."
	{loaded}
	hasReport={!!result}
>
	{#if summary}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Skeleton averages
			</div>
			<div class="mt-3 grid grid-cols-3 gap-3 text-xs">
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Open files</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.openFileAverage.toFixed(2)}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Your pawn islands</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.avgPawnIslandsUser.toFixed(2)}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Opponent islands</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.avgPawnIslandsOpp.toFixed(2)}
					</div>
				</div>
			</div>
			<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
				More islands on your side than on theirs = you end up with the more fractured pawn skeleton.
				That's often a price you pay for activity.
			</p>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Structures you pass through
			</div>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				Overall win rate: <span class="font-mono">{pct(summary.overallWinRate)}</span> across
				{summary.totalGames} games. The "masters share" column compares your structure mix against masters
				playing your colour in the same openings — useful for spotting structures you're gravitating toward
				(or avoiding) relative to model play.
			</p>
			<div class="mt-3">
				<MastersBaselinePanel {result} bind:baseline={mastersBaseline} />
			</div>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Structure</th>
						<th class="text-right">Games</th>
						<th class="text-right">Share</th>
						<th class="text-right">Win rate</th>
						<th class="text-right">Δ vs you</th>
						<th class="text-right">Masters share</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.byStructure as b (b.key)}
						{@const userShare = b.games / summary.totalGames}
						{@const m = mastersByStructure.get(b.key)}
						{@const mTotal = summary.comparisonTotalGames ?? 0}
						{@const mShare = m && mTotal > 0 ? m.games / mTotal : null}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{structureLabel(b.key)}</td>
							<td class="py-1.5 text-right">{b.games}</td>
							<td class="py-1.5 text-right">{pct(userShare)}</td>
							<td class="py-1.5 text-right">{pct(b.winRate)}</td>
							<td class="py-1.5 text-right {tintForWinRate(b.winRate, summary.overallWinRate)}">
								{b.winRate - summary.overallWinRate >= 0 ? '+' : ''}{pct(
									b.winRate - summary.overallWinRate
								)}
							</td>
							<td class="py-1.5 text-right">
								{#if !summary.comparisonByStructure}
									<span class="text-[var(--color-parchment-600)]">—</span>
								{:else if mShare == null || (m?.games ?? 0) < MASTERS_THIN_SAMPLE}
									<span class="text-[var(--color-parchment-600)]" title="Thin sample">
										{m?.games ?? 0}/{mTotal}
									</span>
								{:else}
									<span>{pct(mShare)}</span>
									<span class="ml-1 text-[10px] {tintForShareDelta(userShare - mShare)}">
										{userShare - mShare >= 0 ? '+' : ''}{pct(userShare - mShare)}
									</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
				A structure where your win rate is +5pp or more above your overall average is a strength to
				lean into when choosing openings. The masters comparison flags structural preferences that
				diverge from how strong players handle the same openings — &lt;{MASTERS_THIN_SAMPLE} master games
				per structure renders as a raw count rather than a misleading share.
			</p>
		</section>
	{/if}
</DossierSubpageShell>

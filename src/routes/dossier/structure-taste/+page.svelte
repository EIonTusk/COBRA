<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseStructureTaste, structureLabel } from '$lib/dossier/structureTaste';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(result ? analyseStructureTaste(result.classified) : null);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}

	function tintForWinRate(rate: number, baseline: number): string {
		const delta = rate - baseline;
		if (delta > 0.05) return 'text-emerald-400';
		if (delta < -0.05) return 'text-amber-300';
		return 'text-[var(--color-parchment-300)]';
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
				{summary.totalGames} games.
			</p>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Structure</th>
						<th class="text-right">Games</th>
						<th class="text-right">Share</th>
						<th class="text-right">Win rate</th>
						<th class="text-right">Δ vs you</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.byStructure as b (b.key)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{structureLabel(b.key)}</td>
							<td class="py-1.5 text-right">{b.games}</td>
							<td class="py-1.5 text-right">{pct(b.games / summary.totalGames)}</td>
							<td class="py-1.5 text-right">{pct(b.winRate)}</td>
							<td class="py-1.5 text-right {tintForWinRate(b.winRate, summary.overallWinRate)}">
								{b.winRate - summary.overallWinRate >= 0 ? '+' : ''}{pct(
									b.winRate - summary.overallWinRate
								)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
				A structure where your win rate is +5pp or more above your overall average is a strength to
				lean into when choosing openings.
			</p>
		</section>
	{/if}
</DossierSubpageShell>

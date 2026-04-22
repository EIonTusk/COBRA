<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseDecisionDifficulty } from '$lib/dossier/decisionDifficulty';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(
		result ? analyseDecisionDifficulty(result.evalAxes?.allMoves ?? null) : null
	);

	const maxCpLoss = $derived(
		summary ? Math.max(...summary.byBucket.map((b) => b.avgCpLoss), 1) : 1
	);

	function cp(x: number) {
		return `${x.toFixed(1)}cp`;
	}
	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}
</script>

<DossierSubpageShell
	title="Decision difficulty"
	subtitle="CP loss and blunder rate bucketed by how forgiving each position was. Difficulty = engine gap between top-1 and top-2 in centipawns. A steep climb from forgiving to single-solution positions is the signature of a player who plays fine on easy moves but misses the one-right-answer."
	{loaded}
	hasReport={!!result}
>
	{#if !result?.evalAxes}
		<div
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-4 text-sm"
		>
			This page needs an engine-analysed report with MultiPV data.
		</div>
	{:else if summary}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Headline</div>
			<p class="mt-2 text-sm text-[var(--color-parchment-200)]">
				{#if summary.difficultyGap != null}
					CP-loss gap between the easiest and hardest buckets:
					<span class="font-mono">{cp(summary.difficultyGap)}</span>
					{#if summary.gapSignificant}
						<span class="text-amber-300">(gated by per-bucket SEs)</span>
					{:else}
						<span class="text-[var(--color-parchment-500)]">(within noise band)</span>
					{/if}
				{:else}
					Not enough per-bucket volume to rank difficulty yet.
				{/if}
			</p>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				{summary.totalMoves.toLocaleString()} moves analysed · {summary.excluded.toLocaleString()} excluded
				(no MultiPV alternatives).
			</p>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Avg CP loss by difficulty
			</div>
			<div class="mt-3 space-y-2 text-xs">
				{#each summary.byBucket as b (b.bucket)}
					<div class="flex items-center gap-2">
						<div class="w-52 text-[var(--color-parchment-300)]">{b.label}</div>
						<div class="h-2 flex-1 rounded bg-[var(--color-ink-950)]">
							<div
								class="h-full rounded bg-amber-500/60"
								style:width="{((b.avgCpLoss / maxCpLoss) * 100).toFixed(1)}%"
							></div>
						</div>
						<div class="w-24 text-right font-mono">
							{b.moves > 0 ? cp(b.avgCpLoss) : '—'}
							<span class="text-[10px] text-[var(--color-parchment-500)]">({b.moves})</span>
						</div>
					</div>
				{/each}
			</div>

			<table class="mt-4 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Bucket</th>
						<th class="text-right">Moves</th>
						<th class="text-right">Avg CP loss</th>
						<th class="text-right">CI95</th>
						<th class="text-right">Avg accuracy</th>
						<th class="text-right">Blunder rate</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.byBucket as b (b.bucket)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5 font-sans text-[var(--color-parchment-300)]">{b.label}</td>
							<td class="py-1.5 text-right">{b.moves}</td>
							<td class="py-1.5 text-right">{b.moves > 0 ? cp(b.avgCpLoss) : '—'}</td>
							<td class="py-1.5 text-right text-[var(--color-parchment-500)]">
								{b.moves > 0 ? `${cp(b.avgCpLossCI95.lo)}–${cp(b.avgCpLossCI95.hi)}` : '—'}
							</td>
							<td class="py-1.5 text-right">{b.moves > 0 ? pct(b.avgAccuracy / 100) : '—'}</td>
							<td class="py-1.5 text-right">
								{b.moves > 0 ? pct(b.blunderRate) : '—'}
								<span class="text-[9px] text-[var(--color-parchment-500)]">
									({b.blunders})
								</span>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}
</DossierSubpageShell>

<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseBlunderTiming } from '$lib/dossier/blunderTiming';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(result ? analyseBlunderTiming(result.evalAxes?.allMoves ?? null) : null);

	const maxRate = $derived(summary ? Math.max(...summary.buckets.map((b) => b.rate), 0.01) : 0.01);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}
</script>

<DossierSubpageShell
	title="Blunder timing"
	subtitle="Where in the game your focus breaks down. Blunders + mistakes bucketed by move number across every analysed game."
	{loaded}
	hasReport={!!result}
>
	{#if !result?.evalAxes}
		<div
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-4 text-sm"
		>
			This page needs an engine-analysed report.
		</div>
	{:else if summary}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Headline</div>
			<p class="mt-2 text-sm text-[var(--color-parchment-200)]">
				{#if summary.peakBucketLabel}
					Your blunder+mistake rate peaks in <span class="font-mono">{summary.peakBucketLabel}</span
					>.
				{:else}
					Your blunder rate is flat across the game.
				{/if}
			</p>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				{summary.totalBlunders} blunders across {summary.totalMoves.toLocaleString()} analysed moves.
			</p>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				By move range
			</div>
			<div class="mt-3 space-y-2 text-xs">
				{#each summary.buckets as b (b.label)}
					<div class="flex items-center gap-2">
						<div class="w-24 text-[var(--color-parchment-300)]">{b.label}</div>
						<div class="h-2 flex-1 rounded bg-[var(--color-ink-950)]">
							<div
								class="h-full rounded bg-amber-500/60"
								style:width="{((b.rate / maxRate) * 100).toFixed(1)}%"
							></div>
						</div>
						<div class="w-24 text-right font-mono">
							{b.moves > 0 ? pct(b.rate) : '—'}
							<span class="text-[10px] text-[var(--color-parchment-500)]">({b.moves})</span>
						</div>
					</div>
				{/each}
			</div>
			<table class="mt-4 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Range</th>
						<th class="text-right">Moves</th>
						<th class="text-right">Blunders</th>
						<th class="text-right">Mistakes</th>
						<th class="text-right">Inaccuracies</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.buckets as b (b.label)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{b.label}</td>
							<td class="py-1.5 text-right">{b.moves}</td>
							<td class="py-1.5 text-right">{b.blunders}</td>
							<td class="py-1.5 text-right">{b.mistakes}</td>
							<td class="py-1.5 text-right">{b.inaccuracies}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}
</DossierSubpageShell>

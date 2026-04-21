<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseExchangePropensity } from '$lib/dossier/exchangePropensity';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(result ? analyseExchangePropensity(result.classified) : null);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}
	function signedPct(x: number) {
		return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`;
	}

	const STATE_LABEL = {
		ahead: 'Ahead (>+1.5)',
		equal: 'Equal',
		behind: 'Behind (<−1.5)'
	} as const;
</script>

<DossierSubpageShell
	title="Exchange propensity"
	subtitle="Do you simplify when winning, cling when losing, or trade indiscriminately? Each bucket uses the non-pawn material difference (your side minus opponent) at the moment of the move."
	{loaded}
	hasReport={!!result}
>
	{#if summary}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Headline</div>
			<ul class="mt-2 space-y-1 text-sm text-[var(--color-parchment-200)]">
				<li>
					{#if summary.simplifyWhenAheadDelta > 0.005}
						<span class="text-emerald-300">Textbook simplifier:</span> piece-trade rate jumps
						{signedPct(summary.simplifyWhenAheadDelta)} when you're ahead vs equal.
					{:else if summary.simplifyWhenAheadDelta < -0.005}
						<span class="text-amber-300">Avoids trades when winning:</span> piece-trade rate
						{signedPct(summary.simplifyWhenAheadDelta)} vs equal — you keep complicating even with a lead.
					{:else}
						Trade rate when ahead is roughly the same as equal.
					{/if}
				</li>
				<li>
					{#if summary.clingWhenBehindDelta < -0.005}
						<span class="text-emerald-300">Fights for counterplay:</span> trades
						{signedPct(summary.clingWhenBehindDelta)} less when behind — you dodge simplification.
					{:else if summary.clingWhenBehindDelta > 0.005}
						<span class="text-amber-300">Surrenders:</span> trade rate goes up
						{signedPct(summary.clingWhenBehindDelta)} when behind — bleeding off pieces compounds your
						material deficit.
					{:else}
						Trade rate when behind is roughly the same as equal.
					{/if}
				</li>
			</ul>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				By material state
			</div>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">State</th>
						<th class="text-right">Moves</th>
						<th class="text-right">Capture %</th>
						<th class="text-right">Piece trade %</th>
						<th class="text-right">Pawn trade %</th>
						<th class="text-right">Sac P×B/N</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each ['ahead', 'equal', 'behind'] as const as state (state)}
						{@const b = summary.byState[state]}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{STATE_LABEL[state]}</td>
							<td class="py-1.5 text-right">{b.moves.toLocaleString()}</td>
							<td class="py-1.5 text-right">{pct(b.captureRate)}</td>
							<td class="py-1.5 text-right">{pct(b.pieceTradeRate)}</td>
							<td class="py-1.5 text-right">{pct(b.moves > 0 ? b.pawnTrades / b.moves : 0)}</td>
							<td class="py-1.5 text-right">{b.pieceForPawn}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}
</DossierSubpageShell>

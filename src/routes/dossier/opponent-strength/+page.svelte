<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseOpponentStrength } from '$lib/dossier/opponentStrength';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(
		result ? analyseOpponentStrength(result.classified, result.evalAxes?.allMoves ?? null) : null
	);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}
</script>

<DossierSubpageShell
	title="Opponent strength"
	subtitle="How your CP loss and result scale against weaker vs stronger opponents. Rating gap is opponent − you at the time of the game."
	{loaded}
	hasReport={!!result}
>
	{#if summary}
		{#if summary.headline}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Headline</div>
				<p class="mt-2 text-sm text-[var(--color-parchment-200)]">{summary.headline}</p>
			</section>
		{/if}

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				By rating gap
			</div>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Gap</th>
						<th class="text-right">Games</th>
						<th class="text-right">W/D/L</th>
						<th class="text-right">Win rate</th>
						<th class="text-right">Avg CP loss</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.buckets as b (b.key)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{b.label}</td>
							<td class="py-1.5 text-right">{b.games}</td>
							<td class="py-1.5 text-right">{b.wins}/{b.draws}/{b.losses}</td>
							<td class="py-1.5 text-right">{b.games > 0 ? pct(b.winRate) : '—'}</td>
							<td class="py-1.5 text-right">{b.avgCpLoss != null ? b.avgCpLoss.toFixed(1) : '—'}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
				Ideal pattern: flat CP loss across all bands — you play your game regardless of opp
				strength. Spiking CP loss against stronger players = you mis-shape strategy under pressure.
			</p>
		</section>
	{/if}
</DossierSubpageShell>

<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseEndgameSubtypes, endgameFamilyLabel } from '$lib/dossier/endgameSubtypes';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(
		result ? analyseEndgameSubtypes(result.classified, result.evalAxes?.allMoves ?? null) : null
	);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}
</script>

<DossierSubpageShell
	title="Endgame subtypes"
	subtitle="Conversion and defense rate by endgame family. Entry state is measured at the first move classified as endgame; requires an engine-analysed report."
	{loaded}
	hasReport={!!result}
>
	{#if summary}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Overall endgame
			</div>
			<div class="mt-3 grid grid-cols-3 gap-3 text-xs">
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Endgames reached</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.totalWithEndgame}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Conversion rate (ahead)</div>
					<div class="mt-1 font-mono text-lg text-emerald-300">
						{pct(summary.overallConversionRate)}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Defense rate (behind)</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{pct(summary.overallDefenseRate)}
					</div>
				</div>
			</div>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">By family</div>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Family</th>
						<th class="text-right">Games</th>
						<th class="text-right">W/D/L</th>
						<th class="text-right">Win rate</th>
						<th class="text-right">Conv %</th>
						<th class="text-right">Def %</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.buckets as b (b.family)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{endgameFamilyLabel(b.family)}</td>
							<td class="py-1.5 text-right">{b.games}</td>
							<td class="py-1.5 text-right">{b.wins}/{b.draws}/{b.losses}</td>
							<td class="py-1.5 text-right">{pct(b.winRate)}</td>
							<td class="py-1.5 text-right">
								{b.enteredAhead > 0 ? pct(b.conversionRate) : '—'}
								<span class="text-[10px] text-[var(--color-parchment-500)]">({b.enteredAhead})</span
								>
							</td>
							<td class="py-1.5 text-right">
								{b.enteredBehind > 0 ? pct(b.defenseRate) : '—'}
								<span class="text-[10px] text-[var(--color-parchment-500)]"
									>({b.enteredBehind})</span
								>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
				Numbers in parentheses are the sample size (games entering that state). A family with just
				one or two sample games isn't a reliable signal — focus on rows with double-digit games.
			</p>
		</section>
	{/if}
</DossierSubpageShell>

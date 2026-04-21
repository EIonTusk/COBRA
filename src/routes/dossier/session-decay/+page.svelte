<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseSessionDecay } from '$lib/dossier/sessionDecay';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(
		result ? analyseSessionDecay(result.classified, result.evalAxes?.allMoves ?? null) : null
	);

	const PHASE_LABEL = { opening: 'Opening', middle: 'Middlegame', end: 'Endgame' } as const;
</script>

<DossierSubpageShell
	title="Session decay"
	subtitle="How CP loss trends across game-in-session index, split by phase. Sessions are contiguous runs with ≤ 30 min between games."
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
				{#if summary.worstPhase && summary.worstPhaseDelta != null && summary.worstPhaseDelta > 10}
					Your <span class="font-mono">{PHASE_LABEL[summary.worstPhase]}</span> play degrades most
					across a session — game 4+ averages +{Math.round(summary.worstPhaseDelta)} cp worse than game
					1.
				{:else if summary.worstPhase && summary.worstPhaseDelta != null}
					No big phase-level decay detected across sessions ({summary.worstPhaseDelta.toFixed(0)}cp
					largest gap).
				{:else}
					Not enough multi-game session data to separate phase decay yet.
				{/if}
			</p>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				{summary.sessions} sessions · {summary.multiGameSessions} multi-game.
			</p>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				CP loss by session index & phase
			</div>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Game #</th>
						<th class="text-right">Games</th>
						<th class="text-right">Overall</th>
						<th class="text-right">Opening</th>
						<th class="text-right">Middlegame</th>
						<th class="text-right">Endgame</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.rows as r (r.index)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{r.index === 5 ? '6+' : r.index + 1}</td>
							<td class="py-1.5 text-right">{r.games}</td>
							<td class="py-1.5 text-right">
								{r.overall.avgCpLoss != null ? r.overall.avgCpLoss.toFixed(1) : '—'}
							</td>
							<td class="py-1.5 text-right">
								{r.byPhase.opening.avgCpLoss != null ? r.byPhase.opening.avgCpLoss.toFixed(1) : '—'}
							</td>
							<td class="py-1.5 text-right">
								{r.byPhase.middle.avgCpLoss != null ? r.byPhase.middle.avgCpLoss.toFixed(1) : '—'}
							</td>
							<td class="py-1.5 text-right">
								{r.byPhase.end.avgCpLoss != null ? r.byPhase.end.avgCpLoss.toFixed(1) : '—'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}
</DossierSubpageShell>

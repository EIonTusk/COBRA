<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseDefensiveResource, difficultyLabel } from '$lib/dossier/defensiveResource';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(
		result ? analyseDefensiveResource(result.classified, result.evalAxes?.allMoves ?? null) : null
	);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}
</script>

<DossierSubpageShell
	title="Defensive resourcefulness"
	subtitle="When the eval drops below −150 cp from your POV, do you hold, flip, or collapse? Difficulty is measured by the legal-move count at the moment the losing state first appears."
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
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Overall</div>
			<div class="mt-3 grid grid-cols-3 gap-3 text-xs">
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Losing entries</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.totalLosingEntries}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Defense rate</div>
					<div class="mt-1 font-mono text-lg text-emerald-300">
						{pct(summary.overallDefenseRate)}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Avg legal moves at entry</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.avgLegalMovesAtEntry.toFixed(1)}
					</div>
				</div>
			</div>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				By difficulty
			</div>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				Small legal-move counts signal forced-only-move defense. Large counts mean the defender had
				real choices.
			</p>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Difficulty</th>
						<th class="text-right">Games</th>
						<th class="text-right">Flipped</th>
						<th class="text-right">Held</th>
						<th class="text-right">Lost</th>
						<th class="text-right">Def rate</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.byDifficulty as r (r.bucket)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{difficultyLabel(r.bucket)}</td>
							<td class="py-1.5 text-right">{r.games}</td>
							<td class="py-1.5 text-right text-emerald-300">{r.flipped}</td>
							<td class="py-1.5 text-right">{r.held}</td>
							<td class="py-1.5 text-right text-amber-300">{r.lost}</td>
							<td class="py-1.5 text-right">{r.games > 0 ? pct(r.defenseRate) : '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
				Higher defense rate in the "many-options" bucket than in "few-options" means you convert
				choices into counterplay better than you grind narrow defenses — a creative defender
				profile. Opposite pattern = calm technician.
			</p>
		</section>
	{/if}
</DossierSubpageShell>

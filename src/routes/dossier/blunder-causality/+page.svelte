<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { buildBlunderCausality } from '$lib/dossier/blunderCausality';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(
		result ? buildBlunderCausality(result.evalAxes?.allMoves ?? null) : null
	);

	function phaseLabel(p: 'opening' | 'middle' | 'end') {
		if (p === 'middle') return 'Middlegame';
		if (p === 'end') return 'Endgame';
		return 'Opening';
	}

	function lichessUrl(fen: string) {
		return `https://lichess.org/analysis/standard/${encodeURIComponent(fen)}`;
	}
</script>

<DossierSubpageShell
	title="Blunder causality"
	subtitle="Most blunders are the visible end of a chain — the strategic drift that preceded them is the real cause. For each blunder, we walk backward through your own moves to find the earliest drift move that set the trajectory. Long distances to origin mean tactics training alone won't fix the leak."
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
			<div class="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Blunders</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.totalBlunders}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Traced to origin</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.originsFound}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Avg distance (plies)</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.avgDistanceToBlunder.toFixed(1)}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Opening-induced</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{Math.round(summary.openingInducedFraction * 100)}%
					</div>
				</div>
			</div>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Origins by phase
			</div>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Phase</th>
						<th class="text-right">Origins</th>
						<th class="text-right">Share</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each ['opening', 'middle', 'end'] as const as p (p)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5 font-sans text-[var(--color-parchment-300)]">{phaseLabel(p)}</td>
							<td class="py-1.5 text-right">{summary.byOriginPhase[p]}</td>
							<td class="py-1.5 text-right">
								{summary.originsFound > 0
									? `${Math.round((summary.byOriginPhase[p] / summary.originsFound) * 100)}%`
									: '—'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		{#if summary.origins.length > 0}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
					Traced origins
				</div>
				<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
					Upstream move that set the losing trajectory. Click to open the origin position in Lichess
					analysis.
				</p>
				<ul class="mt-2 grid gap-1">
					{#each summary.origins.slice(0, 30) as o (`${o.gameId}-${o.blunderPly}`)}
						<li>
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={lichessUrl(o.fenBefore)}
								target="_blank"
								rel="noopener"
								class="flex flex-wrap items-baseline justify-between gap-2 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-2 py-1 font-mono text-xs hover:border-[var(--color-brass-300)]/40"
							>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<span>
									#{o.gameId.slice(0, 6)} · {phaseLabel(o.originPhase).toLowerCase()} · ply {o.ply}
									{o.san}
								</span>
								<span class="text-[var(--color-parchment-400)]">
									→ blunder ply {o.blunderPly}
									{o.blunderSan}
									<span class="text-[var(--color-parchment-500)]">({o.distanceToBlunder}p)</span>
								</span>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</DossierSubpageShell>

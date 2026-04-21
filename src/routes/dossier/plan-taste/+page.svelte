<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analysePlanTaste, wingShare } from '$lib/dossier/planTaste';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(result ? analysePlanTaste(result.classified) : null);
	const pieceShare = $derived(summary ? wingShare(summary.pieceAim) : null);
	const stormShare = $derived(summary ? wingShare(summary.pawnStorms) : null);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}

	const PHASE_LABEL = { opening: 'Opening', middle: 'Middlegame', end: 'Endgame' } as const;

	const PLAN_LABEL = {
		'kingside-pressure': 'Kingside pressure',
		'queenside-pressure': 'Queenside pressure',
		'central-play': 'Central play',
		balanced: 'Balanced plan'
	} as const;
</script>

<DossierSubpageShell
	title="Plan taste"
	subtitle="Where do you direct pieces and push pawns? Middlegame destinations split into queenside / center / kingside."
	{loaded}
	hasReport={!!result}
>
	{#if summary}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Dominant plan
			</div>
			<p class="mt-2 font-serif text-xl text-[var(--color-parchment-50)]">
				{PLAN_LABEL[summary.dominantPlan]}
			</p>
			<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
				Out of {summary.totalGames} games. Kingside storms in {summary.kingsideStormGames} (g/h push past
				3rd rank). Queenside/minority pushes in {summary.minorityAttackGames}. Avg user pawn
				advances past 3rd rank per game: {summary.avgPawnPushes.toFixed(2)}.
			</p>
		</section>

		{#if pieceShare}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Piece aim</div>
				<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
					Destination files of middlegame piece moves (excludes pawn moves and castling).
				</p>
				<div class="mt-3 space-y-2 text-xs">
					{#each ['queenside', 'center', 'kingside'] as const as wing (wing)}
						<div class="flex items-center gap-2">
							<div class="w-24 text-[var(--color-parchment-300)] capitalize">{wing}</div>
							<div class="h-2 flex-1 rounded bg-[var(--color-ink-950)]">
								<div
									class="h-full rounded bg-[var(--color-brass-300)]/60"
									style:width="{(pieceShare[wing] * 100).toFixed(1)}%"
								></div>
							</div>
							<div class="w-12 text-right font-mono">{pct(pieceShare[wing])}</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		{#if stormShare}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
					Pawn storms
				</div>
				<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
					Destination of every user pawn push past its 3rd rank (storm indicator).
				</p>
				<div class="mt-3 space-y-2 text-xs">
					{#each ['queenside', 'center', 'kingside'] as const as wing (wing)}
						<div class="flex items-center gap-2">
							<div class="w-24 text-[var(--color-parchment-300)] capitalize">{wing}</div>
							<div class="h-2 flex-1 rounded bg-[var(--color-ink-950)]">
								<div
									class="h-full rounded bg-emerald-500/60"
									style:width="{(stormShare[wing] * 100).toFixed(1)}%"
								></div>
							</div>
							<div class="w-12 text-right font-mono">{pct(stormShare[wing])}</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		{#if result}
			{@const fp = result.fingerprint}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
					Style axes by phase
				</div>
				<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
					Raw forcing / capture / pawn / queenside rates split by game phase — lets you see how your
					plan shifts as the position simplifies.
				</p>
				<div class="mt-3 overflow-x-auto">
					<table class="w-full border-collapse text-sm">
						<thead class="text-left text-xs text-[var(--color-parchment-500)]">
							<tr>
								<th class="py-2 pr-4">Phase</th>
								<th class="py-2 pr-4">Moves</th>
								<th class="py-2 pr-4">Forcing</th>
								<th class="py-2 pr-4">Capture</th>
								<th class="py-2 pr-4">Pawn play</th>
								<th class="py-2 pr-4">Queenside</th>
							</tr>
						</thead>
						<tbody>
							{#each ['opening', 'middle', 'end'] as const as phase (phase)}
								{@const p = fp.byPhase[phase]}
								<tr class="border-t border-[var(--color-ink-800)]">
									<td class="py-2 pr-4 font-medium">{PHASE_LABEL[phase]}</td>
									<td class="py-2 pr-4 font-mono">{p.moves}</td>
									<td class="py-2 pr-4 font-mono">{pct(p.forcing)}</td>
									<td class="py-2 pr-4 font-mono">{pct(p.capture)}</td>
									<td class="py-2 pr-4 font-mono">{pct(p.pawnPlay)}</td>
									<td class="py-2 pr-4 font-mono">{pct(p.queenside)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}
	{/if}
</DossierSubpageShell>

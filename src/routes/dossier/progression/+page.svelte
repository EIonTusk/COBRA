<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseProgression } from '$lib/dossier/progression';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(
		result ? analyseProgression(result.classified, result.evalAxes?.allMoves ?? null) : null
	);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}
	function signed(x: number | null, digits = 0): string {
		if (x == null) return '—';
		const v = x.toFixed(digits);
		return x >= 0 ? `+${v}` : v;
	}

	const DIRECTION_TINT = {
		improving: 'border-emerald-500/40 bg-emerald-950/15',
		slipping: 'border-amber-300/40 bg-amber-950/15',
		stable: 'border-[var(--color-ink-800)] bg-[var(--color-ink-950)]'
	} as const;
</script>

<DossierSubpageShell
	title="Progression"
	subtitle="Monthly roll-up of rating, CP loss, result rate, and style axes. Were you actually getting better last quarter, or just playing more?"
	{loaded}
	hasReport={!!result}
>
	{#if summary}
		{#if summary.direction}
			<section class="mt-6 rounded border px-4 py-4 text-sm {DIRECTION_TINT[summary.direction]}">
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Direction</div>
				<p class="mt-2 text-[var(--color-parchment-100)]">
					{#if summary.direction === 'improving'}
						You're <span class="font-mono">improving</span>. Rating {signed(summary.deltaRating)} · CP
						loss {signed(summary.deltaCpLoss, 1)} · win rate {signed(
							(summary.deltaWinRate ?? 0) * 100,
							1
						)}pp first→last month.
					{:else if summary.direction === 'slipping'}
						You're <span class="font-mono">slipping</span>. Rating {signed(summary.deltaRating)} · CP
						loss {signed(summary.deltaCpLoss, 1)} · win rate {signed(
							(summary.deltaWinRate ?? 0) * 100,
							1
						)}pp first→last month.
					{:else}
						You're <span class="font-mono">stable</span>. Rating {signed(summary.deltaRating)} · CP loss
						{signed(summary.deltaCpLoss, 1)} · win rate {signed(
							(summary.deltaWinRate ?? 0) * 100,
							1
						)}pp first→last month.
					{/if}
				</p>
			</section>
		{/if}

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">By month</div>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Month</th>
						<th class="text-right">Games</th>
						<th class="text-right">W/D/L</th>
						<th class="text-right">Win rate</th>
						<th class="text-right">Rating</th>
						<th class="text-right">CP loss</th>
						<th class="text-right">Blunder %</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.months as m (m.monthKey)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{m.label}</td>
							<td class="py-1.5 text-right">{m.games}</td>
							<td class="py-1.5 text-right">{m.wins}/{m.draws}/{m.losses}</td>
							<td class="py-1.5 text-right">{pct(m.winRate)}</td>
							<td class="py-1.5 text-right">{m.avgRating != null ? m.avgRating.toFixed(0) : '—'}</td
							>
							<td class="py-1.5 text-right">{m.avgCpLoss != null ? m.avgCpLoss.toFixed(1) : '—'}</td
							>
							<td class="py-1.5 text-right">{m.blunderRate != null ? pct(m.blunderRate) : '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Axes over time
			</div>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Month</th>
						<th class="text-right">Forcing</th>
						<th class="text-right">Captures</th>
						<th class="text-right">Pawn moves</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.months as m (m.monthKey)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{m.label}</td>
							<td class="py-1.5 text-right">{pct(m.forcing)}</td>
							<td class="py-1.5 text-right">{pct(m.capture)}</td>
							<td class="py-1.5 text-right">{pct(m.pawnPlay)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}
</DossierSubpageShell>

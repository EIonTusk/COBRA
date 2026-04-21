<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseCalculationDepth, type ComplexityBucket } from '$lib/dossier/calculationDepth';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(
		result ? analyseCalculationDepth(result.classified, result.evalAxes?.allMoves ?? null) : null
	);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}

	function renderTable(buckets: ComplexityBucket[]) {
		return buckets;
	}
</script>

<DossierSubpageShell
	title="Calculation depth"
	subtitle="How well does your accuracy hold as position complexity rises? Compares CP loss and blunder rate at low-branching positions vs high-branching, and under tactical tension."
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
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				By branching factor
			</div>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				Number of legal moves available when you moved. Higher branching = more candidates to
				evaluate.
			</p>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Range</th>
						<th class="text-right">Moves</th>
						<th class="text-right">Avg CP loss</th>
						<th class="text-right">Blunder %</th>
						<th class="text-right">Inacc %</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each renderTable(summary.byBranching) as b (b.label)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{b.label}</td>
							<td class="py-1.5 text-right">{b.moves}</td>
							<td class="py-1.5 text-right">{b.moves > 0 ? b.avgCpLoss.toFixed(1) : '—'}</td>
							<td class="py-1.5 text-right">{b.moves > 0 ? pct(b.blunderRate) : '—'}</td>
							<td class="py-1.5 text-right">{b.moves > 0 ? pct(b.inaccuracyRate) : '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Under pawn tension
			</div>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				Tense pawn-pair count on the board when you moved.
			</p>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Range</th>
						<th class="text-right">Moves</th>
						<th class="text-right">Avg CP loss</th>
						<th class="text-right">Blunder %</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.byTension as b (b.label)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{b.label}</td>
							<td class="py-1.5 text-right">{b.moves}</td>
							<td class="py-1.5 text-right">{b.moves > 0 ? b.avgCpLoss.toFixed(1) : '—'}</td>
							<td class="py-1.5 text-right">{b.moves > 0 ? pct(b.blunderRate) : '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Hanging-threat split
			</div>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				Were you facing a hanging capture at the time of the decision?
			</p>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">State</th>
						<th class="text-right">Moves</th>
						<th class="text-right">Avg CP loss</th>
						<th class="text-right">Blunder %</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.byHangingThreat as b (b.label)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{b.label}</td>
							<td class="py-1.5 text-right">{b.moves}</td>
							<td class="py-1.5 text-right">{b.moves > 0 ? b.avgCpLoss.toFixed(1) : '—'}</td>
							<td class="py-1.5 text-right">{b.moves > 0 ? pct(b.blunderRate) : '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		{#if result}
			{@const fp = result.fingerprint}
			{@const ref = fp.overall}
			{@const clockHasData =
				fp.byClock.low.moves + fp.byClock.mid.moves + fp.byClock.high.moves > 0}
			{#if clockHasData}
				{#snippet clockLabel(k: 'low' | 'mid' | 'high')}
					{#if k === 'low'}&lt;10s{:else if k === 'mid'}10–60s{:else}60s+{/if}
				{/snippet}
				<section
					class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
				>
					<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
						Style axes by remaining clock
					</div>
					<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
						Buckets your moves by the clock you had when deciding — a panic-attack detector
						complementing the branching-factor chart above. Deltas vs overall; ≥3pp colours.
					</p>
					<div class="mt-3 overflow-x-auto">
						<table class="w-full border-collapse text-sm">
							<thead class="text-left text-xs text-[var(--color-parchment-500)]">
								<tr>
									<th class="py-2 pr-4">Clock</th>
									<th class="py-2 pr-4">Moves</th>
									<th class="py-2 pr-4">Forcing</th>
									<th class="py-2 pr-4">Capture</th>
									<th class="py-2 pr-4">Pawn</th>
									<th class="py-2 pr-4">Queenside</th>
								</tr>
							</thead>
							<tbody>
								{#each ['high', 'mid', 'low'] as const as k (k)}
									{@const r = fp.byClock[k]}
									<tr class="border-t border-[var(--color-ink-800)]">
										<td class="py-2 pr-4 font-medium">{@render clockLabel(k)}</td>
										<td class="py-2 pr-4 font-mono">{r.moves}</td>
										<td class="py-2 pr-4 font-mono">
											{r.moves > 0 ? pct(r.forcing) : '—'}
											{#if r.moves > 0}
												<span
													class="ml-1 text-xs {r.forcing - ref.forcing > 0.03
														? 'text-emerald-400'
														: r.forcing - ref.forcing < -0.03
															? 'text-amber-300'
															: 'text-[var(--color-parchment-500)]'}"
												>
													{r.forcing - ref.forcing >= 0 ? '+' : ''}{(
														(r.forcing - ref.forcing) *
														100
													).toFixed(1)}
												</span>
											{/if}
										</td>
										<td class="py-2 pr-4 font-mono">
											{r.moves > 0 ? pct(r.capture) : '—'}
											{#if r.moves > 0}
												<span
													class="ml-1 text-xs {r.capture - ref.capture > 0.03
														? 'text-emerald-400'
														: r.capture - ref.capture < -0.03
															? 'text-amber-300'
															: 'text-[var(--color-parchment-500)]'}"
												>
													{r.capture - ref.capture >= 0 ? '+' : ''}{(
														(r.capture - ref.capture) *
														100
													).toFixed(1)}
												</span>
											{/if}
										</td>
										<td class="py-2 pr-4 font-mono">
											{r.moves > 0 ? pct(r.pawnPlay) : '—'}
											{#if r.moves > 0}
												<span
													class="ml-1 text-xs {r.pawnPlay - ref.pawnPlay > 0.03
														? 'text-emerald-400'
														: r.pawnPlay - ref.pawnPlay < -0.03
															? 'text-amber-300'
															: 'text-[var(--color-parchment-500)]'}"
												>
													{r.pawnPlay - ref.pawnPlay >= 0 ? '+' : ''}{(
														(r.pawnPlay - ref.pawnPlay) *
														100
													).toFixed(1)}
												</span>
											{/if}
										</td>
										<td class="py-2 pr-4 font-mono">
											{r.moves > 0 ? pct(r.queenside) : '—'}
											{#if r.moves > 0}
												<span
													class="ml-1 text-xs {r.queenside - ref.queenside > 0.03
														? 'text-emerald-400'
														: r.queenside - ref.queenside < -0.03
															? 'text-amber-300'
															: 'text-[var(--color-parchment-500)]'}"
												>
													{r.queenside - ref.queenside >= 0 ? '+' : ''}{(
														(r.queenside - ref.queenside) *
														100
													).toFixed(1)}
												</span>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</section>
			{/if}
		{/if}
	{/if}
</DossierSubpageShell>

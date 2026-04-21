<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { buildExemplars } from '$lib/dossier/exemplars';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(result ? buildExemplars(result.classified) : null);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}

	function lichessGameUrl(id: string): string {
		return `https://lichess.org/${id}`;
	}
</script>

<DossierSubpageShell
	title="Exemplars"
	subtitle="The three games that most look like you play, and the three that most look like you in a foreign gear. Per-game style axes compared to your overall fingerprint."
	{loaded}
	hasReport={!!result}
>
	{#if summary}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Your overall axes
			</div>
			<div class="mt-3 grid grid-cols-4 gap-3 text-xs">
				{#each [['Forcing', summary.yourAxes.forcing], ['Captures', summary.yourAxes.capture], ['Pawn moves', summary.yourAxes.pawnPlay], ['Queenside', summary.yourAxes.queenside]] as const as [label, value] (label)}
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
					>
						<div class="text-[var(--color-parchment-500)]">{label}</div>
						<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">{pct(value)}</div>
					</div>
				{/each}
			</div>
		</section>

		<section class="mt-6">
			<h2 class="text-sm font-medium text-[var(--color-parchment-200)]">Most representative</h2>
			<p class="text-xs text-[var(--color-parchment-500)]">
				Closest match to your overall axes. These are the games that look most like "you".
			</p>
			<ul class="mt-3 grid gap-2">
				{#each summary.representative as g (g.gameId)}
					{@const url = lichessGameUrl(g.gameId)}
					<li class="rounded border border-emerald-500/30 bg-emerald-950/10 px-3 py-2 text-xs">
						<div class="flex items-baseline justify-between">
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={url}
								target="_blank"
								rel="noopener"
								class="font-mono text-[var(--color-parchment-100)] hover:underline"
							>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								#{g.gameId.slice(0, 6)}
							</a>
							<span class="text-[var(--color-parchment-400)]">
								{g.color} · {g.result} · vs {g.opponentUsername ?? '?'} ({g.opponentRating ?? '?'})
							</span>
						</div>
						<div class="mt-1 text-[var(--color-parchment-500)]">
							{g.openingName ?? g.eco ?? 'Unknown'} · distance {g.distance.toFixed(3)} · {g.moves} user
							moves
						</div>
						<div class="mt-1 grid grid-cols-4 gap-1 text-[10px]">
							<span>F: {pct(g.axes.forcing)}</span>
							<span>C: {pct(g.axes.capture)}</span>
							<span>P: {pct(g.axes.pawnPlay)}</span>
							<span>Q: {pct(g.axes.queenside)}</span>
						</div>
					</li>
				{/each}
			</ul>
		</section>

		<section class="mt-6">
			<h2 class="text-sm font-medium text-[var(--color-parchment-200)]">Most contradictory</h2>
			<p class="text-xs text-[var(--color-parchment-500)]">
				Your outlier games — how you played when you weren't being yourself. Worth reviewing to see
				if that gear served you.
			</p>
			<ul class="mt-3 grid gap-2">
				{#each summary.contradictory as g (g.gameId)}
					{@const url = lichessGameUrl(g.gameId)}
					<li class="rounded border border-amber-300/30 bg-amber-950/10 px-3 py-2 text-xs">
						<div class="flex items-baseline justify-between">
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={url}
								target="_blank"
								rel="noopener"
								class="font-mono text-[var(--color-parchment-100)] hover:underline"
							>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								#{g.gameId.slice(0, 6)}
							</a>
							<span class="text-[var(--color-parchment-400)]">
								{g.color} · {g.result} · vs {g.opponentUsername ?? '?'} ({g.opponentRating ?? '?'})
							</span>
						</div>
						<div class="mt-1 text-[var(--color-parchment-500)]">
							{g.openingName ?? g.eco ?? 'Unknown'} · distance {g.distance.toFixed(3)} · {g.moves} user
							moves
						</div>
						<div class="mt-1 grid grid-cols-4 gap-1 text-[10px]">
							<span>F: {pct(g.axes.forcing)}</span>
							<span>C: {pct(g.axes.capture)}</span>
							<span>P: {pct(g.axes.pawnPlay)}</span>
							<span>Q: {pct(g.axes.queenside)}</span>
						</div>
					</li>
				{/each}
			</ul>
		</section>

		{#if result}
			{@const fp = result.fingerprint}
			{@const ref = fp.overall}
			{#snippet resultLabel(k: 'win' | 'loss' | 'draw')}
				{#if k === 'win'}In wins{:else if k === 'loss'}In losses{:else}In draws{/if}
			{/snippet}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
					Style axes by result
				</div>
				<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
					Aggregate axes split by the game outcome — if your forcing or capture rate spikes in
					losses, that's a behavioural leak the overall numbers hide. Deltas are vs your overall
					average; ≥3pp gaps are coloured.
				</p>
				<div class="mt-3 overflow-x-auto">
					<table class="w-full border-collapse text-sm">
						<thead class="text-left text-xs text-[var(--color-parchment-500)]">
							<tr>
								<th class="py-2 pr-4">Outcome</th>
								<th class="py-2 pr-4">Games</th>
								<th class="py-2 pr-4">Moves</th>
								<th class="py-2 pr-4">Forcing</th>
								<th class="py-2 pr-4">Capture</th>
								<th class="py-2 pr-4">Pawn</th>
								<th class="py-2 pr-4">Queenside</th>
							</tr>
						</thead>
						<tbody>
							{#each ['win', 'loss', 'draw'] as const as k (k)}
								{@const r = fp.byResult[k]}
								<tr class="border-t border-[var(--color-ink-800)]">
									<td class="py-2 pr-4 font-medium">{@render resultLabel(k)}</td>
									<td class="py-2 pr-4 font-mono">{r.games}</td>
									<td class="py-2 pr-4 font-mono">{r.moves}</td>
									<td class="py-2 pr-4 font-mono">
										{pct(r.forcing)}
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
									</td>
									<td class="py-2 pr-4 font-mono">
										{pct(r.capture)}
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
									</td>
									<td class="py-2 pr-4 font-mono">
										{pct(r.pawnPlay)}
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
									</td>
									<td class="py-2 pr-4 font-mono">
										{pct(r.queenside)}
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
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
					Outcomes with fewer than 50 user moves are shown but reads should be muted.
				</p>
			</section>
		{/if}
	{/if}
</DossierSubpageShell>

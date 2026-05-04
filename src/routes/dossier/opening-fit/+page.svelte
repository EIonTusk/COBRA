<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { resolve } from '$app/paths';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import MastersBaselinePanel from '$lib/dossier/MastersBaselinePanel.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseOpeningFit } from '$lib/dossier/openingFit';
	import { fingerprintFromGames, type OpeningProfile } from '$lib/dossier/fingerprint';
	import type { OpeningFamily } from '$lib/dossier/openings';
	import type { DossierScanResult } from '$lib/dossier/scan';
	import type { LoadedMastersBaseline } from '$lib/storage/mastersBaseline';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);
	let mastersBaseline = $state<LoadedMastersBaseline | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(
		result ? analyseOpeningFit(result.classified, result.evalAxes?.allMoves ?? null) : null
	);

	// Per-family axes for masters playing the user's colour in the user's
	// chosen openings. Keyed by `OpeningFamily` (the same coarse ECO bucket
	// the user's `byOpening` rows use), so a row-level lookup just matches
	// on family. Empty map when the masters baseline hasn't been fetched.
	const mastersByFamily = $derived.by(() => {
		const map = new SvelteMap<OpeningFamily, OpeningProfile>();
		if (!mastersBaseline?.games.length) return map;
		const fp = fingerprintFromGames(mastersBaseline.games);
		for (const o of fp.byOpening) map.set(o.family, o);
		return map;
	});

	function pct(x: number, digits = 1) {
		return `${(x * 100).toFixed(digits)}%`;
	}
	function signedPct(x: number) {
		return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`;
	}
	function signedCp(x: number) {
		return `${x >= 0 ? '+' : ''}${x.toFixed(1)}cp`;
	}

	function tint(v: 'fit' | 'neutral' | 'misfit') {
		if (v === 'fit') return 'border-emerald-500/50 bg-emerald-950/15';
		if (v === 'misfit') return 'border-amber-300/40 bg-amber-950/15';
		return 'border-[var(--color-ink-800)] bg-[var(--color-ink-950)]';
	}

	function deltaClass(d: number) {
		if (d > 0.03) return 'text-emerald-400';
		if (d < -0.03) return 'text-amber-300';
		return 'text-[var(--color-parchment-500)]';
	}
	function signedPp(d: number) {
		return `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}`;
	}
</script>

<DossierSubpageShell
	title="Opening fit"
	subtitle="Cross-references your win rate and CP-loss in each ECO family against your overall baseline, so you can see which openings reward your actual skillset."
	{loaded}
	hasReport={!!result}
>
	{#if summary}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Your baseline
			</div>
			<div class="mt-3 grid grid-cols-2 gap-3 text-xs">
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Overall win rate</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{pct(summary.overallWinRate)}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Overall avg CP loss</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.overallCpLoss.toFixed(1)}
					</div>
				</div>
			</div>
		</section>

		<a
			href={resolve('/dossier/repertoire-fit')}
			class="mt-4 block rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-4 py-3 text-xs hover:border-[var(--color-brass-300)]/40"
		>
			<span class="text-[var(--color-parchment-200)]">Repertoire fit →</span>
			<span class="ml-2 text-[var(--color-parchment-500)]">
				Same data sliced by which of your repertoires each game falls into. Useful when one
				colour-side spans multiple prep trees.
			</span>
		</a>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Per-family fit
			</div>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				Green = fit (+5pp win rate and ≥5cp lower CP loss). Amber = misfit (opposite). Axis mismatch
				is L1 distance of your style axes in that family vs your overall. Requires an
				engine-analysed report for CP loss.
			</p>
			<ul class="mt-3 grid gap-2">
				{#each summary.rows as r (r.family)}
					<li class="rounded border px-3 py-2 text-xs {tint(r.verdict)}">
						<div class="flex flex-wrap items-baseline justify-between gap-2">
							<span class="text-[var(--color-parchment-100)]">{r.family}</span>
							<span class="font-mono text-[var(--color-parchment-400)]">{r.games} games</span>
						</div>
						<div class="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
							<div>
								<div class="text-[var(--color-parchment-500)]">Win rate</div>
								<div class="mt-0.5 font-mono">{pct(r.winRate)}</div>
								<div class="text-[10px] text-[var(--color-parchment-500)]">
									{signedPct(r.winRateDelta)} vs you
								</div>
							</div>
							<div>
								<div class="text-[var(--color-parchment-500)]">Avg CP loss</div>
								<div class="mt-0.5 font-mono">{r.avgCpLoss ? r.avgCpLoss.toFixed(1) : '—'}</div>
								<div class="text-[10px] text-[var(--color-parchment-500)]">
									{r.avgCpLoss ? signedCp(r.avgCpLossDelta) + ' vs you' : 'needs eval'}
								</div>
							</div>
							<div>
								<div class="text-[var(--color-parchment-500)]">Axis mismatch</div>
								<div class="mt-0.5 font-mono">{r.axisMismatch.toFixed(3)}</div>
							</div>
							<div>
								<div class="text-[var(--color-parchment-500)]">Result split</div>
								<div class="mt-0.5 font-mono">W{r.wins}·D{r.draws}·L{r.losses}</div>
							</div>
						</div>
					</li>
				{/each}
			</ul>
		</section>

		{#if result}
			{@const fp = result.fingerprint}
			{@const ref = fp.overall}
			{@const overallWR =
				(fp.results.win + 0.5 * fp.results.draw) /
				Math.max(1, fp.results.win + fp.results.loss + fp.results.draw)}
			{@const big = fp.byOpening.filter((o) => o.games >= 5).slice(0, 12)}
			{@const small = fp.byOpening.filter((o) => o.games < 5)}
			{@const other =
				small.length === 0
					? null
					: {
							games: small.reduce((s, o) => s + o.games, 0),
							wins: small.reduce((s, o) => s + o.wins, 0),
							losses: small.reduce((s, o) => s + o.losses, 0),
							draws: small.reduce((s, o) => s + o.draws, 0)
						}}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
					Style axes by opening family
				</div>
				<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
					Per-ECO bucketing — what you actually score in vs what you just play often, with axis
					rates for each family. Families with &lt;5 games fold into "Other". The "vs you" delta
					compares this family against your overall; "vs masters" compares against masters playing
					your colour in the same family (only families you chose qualify for the masters
					comparison).
				</p>
				<div class="mt-3">
					<MastersBaselinePanel {result} bind:baseline={mastersBaseline} />
				</div>
				<div class="mt-3 overflow-x-auto">
					<table class="w-full border-collapse text-sm">
						<thead class="text-left text-xs text-[var(--color-parchment-500)]">
							<tr>
								<th class="py-2 pr-4">Family</th>
								<th class="py-2 pr-4">Games</th>
								<th class="py-2 pr-4">W/L/D</th>
								<th class="py-2 pr-4">Win rate</th>
								<th class="py-2 pr-4">Forcing</th>
								<th class="py-2 pr-4">Pawn</th>
								<th class="py-2 pr-4">Queenside</th>
							</tr>
						</thead>
						<tbody>
							{#each big as o (o.family)}
								{@const m = mastersByFamily.get(o.family) ?? null}
								{@const mGames = m?.games ?? 0}
								<tr class="border-t border-[var(--color-ink-800)] align-top">
									<td class="py-2 pr-4 font-medium">{o.family}</td>
									<td class="py-2 pr-4 font-mono">{o.games}</td>
									<td class="py-2 pr-4 font-mono text-xs">
										{o.wins}/{o.losses}/{o.draws}
									</td>
									<td class="py-2 pr-4 font-mono">
										<div>{pct(o.winRate, 1)}</div>
										<div class="text-xs {deltaClass(o.winRate - overallWR)}">
											{signedPp(o.winRate - overallWR)} vs you
										</div>
									</td>
									<td class="py-2 pr-4 font-mono">
										<div>{pct(o.forcing, 1)}</div>
										<div class="text-xs {deltaClass(o.forcing - ref.forcing)}">
											{signedPp(o.forcing - ref.forcing)} vs you
										</div>
										{#if m}
											<div
												class="text-xs {deltaClass(o.forcing - m.forcing)}"
												title="{mGames} master games"
											>
												{signedPp(o.forcing - m.forcing)} vs masters
											</div>
										{/if}
									</td>
									<td class="py-2 pr-4 font-mono">
										<div>{pct(o.pawnPlay, 1)}</div>
										<div class="text-xs {deltaClass(o.pawnPlay - ref.pawnPlay)}">
											{signedPp(o.pawnPlay - ref.pawnPlay)} vs you
										</div>
										{#if m}
											<div
												class="text-xs {deltaClass(o.pawnPlay - m.pawnPlay)}"
												title="{mGames} master games"
											>
												{signedPp(o.pawnPlay - m.pawnPlay)} vs masters
											</div>
										{/if}
									</td>
									<td class="py-2 pr-4 font-mono">
										<div>{pct(o.queenside, 1)}</div>
										<div class="text-xs {deltaClass(o.queenside - ref.queenside)}">
											{signedPp(o.queenside - ref.queenside)} vs you
										</div>
										{#if m}
											<div
												class="text-xs {deltaClass(o.queenside - m.queenside)}"
												title="{mGames} master games"
											>
												{signedPp(o.queenside - m.queenside)} vs masters
											</div>
										{/if}
									</td>
								</tr>
							{/each}
							{#if other}
								<tr
									class="border-t border-[var(--color-ink-800)] text-[var(--color-parchment-500)]"
								>
									<td class="py-2 pr-4 italic">Other (small samples)</td>
									<td class="py-2 pr-4 font-mono">{other.games}</td>
									<td class="py-2 pr-4 font-mono text-xs">
										{other.wins}/{other.losses}/{other.draws}
									</td>
									<td colspan="4"></td>
								</tr>
							{/if}
						</tbody>
					</table>
				</div>
			</section>
		{/if}
	{/if}
</DossierSubpageShell>

<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import {
		buildOpeningProfileByRepertoire,
		type RepertoireProfileBucket
	} from '$lib/dossier/openingProfileByRepertoire';
	import { buildOpeningProfile } from '$lib/dossier/openingProfile';
	import { listRepertoires } from '$lib/storage/repertoires';
	import { listNodes } from '$lib/storage/nodes';
	import type { DossierScanResult } from '$lib/dossier/scan';
	import type { Repertoire, RepertoireNode } from '$lib/types';
	import type { ClassifiedGame } from '$lib/dossier/classify';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);
	let repertoireBundle = $state<Array<{ repertoire: Repertoire; nodes: RepertoireNode[] }>>([]);

	onMount(async () => {
		const [saved, repList] = await Promise.all([loadDossierReport(), listRepertoires()]);
		if (saved?.payload) result = saved.payload as DossierScanResult;
		repertoireBundle = await Promise.all(
			repList.map(async (r) => ({ repertoire: r, nodes: await listNodes(r.id) }))
		);
		loaded = true;
	});

	const baseline = $derived(
		result ? buildOpeningProfile(result.classified, result.evalAxes?.allMoves ?? null) : null
	);

	const byRepertoire = $derived(
		result
			? buildOpeningProfileByRepertoire(
					result.classified,
					result.evalAxes?.allMoves ?? null,
					repertoireBundle
				)
			: null
	);

	function pctFmt(x: number, digits = 1) {
		return `${(x * 100).toFixed(digits)}%`;
	}
	function signedPp(x: number, digits = 1) {
		return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}pp`;
	}
	function signedCp(x: number, digits = 1) {
		return `${x >= 0 ? '+' : ''}${x.toFixed(digits)}cp`;
	}

	// Stair-stepped brass opacity for the corpus-composition bar. Matches
	// the dossier's "single tone, varied weight" convention; the largest
	// bucket gets the heaviest fill, smaller buckets fade out. Unattributed
	// uses a muted parchment tone instead.
	const PALETTE = [
		'bg-[var(--color-brass-300)]/70',
		'bg-[var(--color-brass-300)]/55',
		'bg-[var(--color-brass-300)]/45',
		'bg-[var(--color-brass-300)]/35',
		'bg-[var(--color-brass-300)]/28',
		'bg-[var(--color-brass-300)]/22',
		'bg-[var(--color-brass-300)]/18'
	];

	function repColor(idx: number): string {
		return PALETTE[idx % PALETTE.length];
	}

	function pctOf(part: number, total: number): number {
		return total > 0 ? part / total : 0;
	}

	// Symmetric diverging bar: returns left-fill width and right-fill width
	// in % strings, centred on 50%. Magnitude is clamped to `max` so very
	// large deltas don't push past the half-track.
	function divergingBar(delta: number, max: number): { left: string; right: string } {
		if (max <= 0) return { left: '0%', right: '0%' };
		const mag = Math.min(Math.abs(delta), max) / max; // 0..1
		const half = (mag * 50).toFixed(1);
		return delta >= 0 ? { left: '0%', right: `${half}%` } : { left: `${half}%`, right: '0%' };
	}

	function deltaTone(delta: number, threshold: number): string {
		if (delta > threshold) return 'text-emerald-300';
		if (delta < -threshold) return 'text-amber-300';
		return 'text-[var(--color-parchment-400)]';
	}

	// CP delta is "lower is better" — invert the tone vs win-rate delta.
	function cpDeltaTone(delta: number, threshold: number): string {
		if (delta < -threshold) return 'text-emerald-300';
		if (delta > threshold) return 'text-amber-300';
		return 'text-[var(--color-parchment-400)]';
	}

	type SegmentTone = 'positive' | 'neutral' | 'negative';
	function segmentClass(tone: SegmentTone): string {
		if (tone === 'positive') return 'bg-emerald-500/45';
		if (tone === 'negative') return 'bg-amber-500/45';
		return 'bg-[var(--color-parchment-400)]/30';
	}

	interface BucketViewModel {
		key: string;
		title: string;
		colorBadge: string | null;
		games: number;
		wins: number;
		draws: number;
		losses: number;
		winRate: number;
		winRateDelta: number;
		avgCp: number | null;
		cpDelta: number | null;
		topRows: ReturnType<typeof buildOpeningProfile>['rows'];
		repertoireId: string | null;
		isUnattributed: boolean;
		paletteIdx: number;
	}

	function tally(bucket: RepertoireProfileBucket | { games: ClassifiedGame[] }) {
		let w = 0,
			d = 0,
			l = 0;
		for (const g of bucket.games) {
			if (g.result === 'win') w += 1;
			else if (g.result === 'draw') d += 1;
			else l += 1;
		}
		return { wins: w, draws: d, losses: l };
	}

	const viewModels = $derived.by((): BucketViewModel[] => {
		if (!byRepertoire || !baseline) return [];
		const out: BucketViewModel[] = [];
		byRepertoire.buckets.forEach((bucket, i) => {
			if (bucket.games.length === 0) return;
			const wdl = tally(bucket);
			out.push({
				key: bucket.repertoire.id,
				title: bucket.repertoire.name,
				colorBadge: bucket.repertoire.color,
				games: bucket.games.length,
				wins: wdl.wins,
				draws: wdl.draws,
				losses: wdl.losses,
				winRate: bucket.profile.userWinRate,
				winRateDelta: bucket.profile.userWinRate - baseline.userWinRate,
				avgCp: bucket.profile.userAvgCpLoss,
				cpDelta:
					bucket.profile.userAvgCpLoss != null && baseline.userAvgCpLoss != null
						? bucket.profile.userAvgCpLoss - baseline.userAvgCpLoss
						: null,
				topRows: bucket.profile.rows.slice(0, 5),
				repertoireId: bucket.repertoire.id,
				isUnattributed: false,
				paletteIdx: i
			});
		});
		// Sort active buckets by game count descending.
		out.sort((a, b) => b.games - a.games);
		// Re-stripe palette in display order.
		out.forEach((v, i) => (v.paletteIdx = i));

		if (byRepertoire.unattributed.length > 0) {
			const wdl = tally({ games: byRepertoire.unattributed });
			out.push({
				key: '__unattributed',
				title: 'Unattributed',
				colorBadge: null,
				games: byRepertoire.unattributed.length,
				wins: wdl.wins,
				draws: wdl.draws,
				losses: wdl.losses,
				winRate: byRepertoire.unattributedProfile.userWinRate,
				winRateDelta: byRepertoire.unattributedProfile.userWinRate - baseline.userWinRate,
				avgCp: byRepertoire.unattributedProfile.userAvgCpLoss,
				cpDelta:
					byRepertoire.unattributedProfile.userAvgCpLoss != null && baseline.userAvgCpLoss != null
						? byRepertoire.unattributedProfile.userAvgCpLoss - baseline.userAvgCpLoss
						: null,
				topRows: byRepertoire.unattributedProfile.rows.slice(0, 5),
				repertoireId: null,
				isUnattributed: true,
				paletteIdx: -1
			});
		}
		return out;
	});

	// Cap diverging bar magnitudes at sensible values so tiny deltas still
	// register but extreme outliers don't visually dominate the layout.
	const MAX_WR_DELTA = 0.2; // 20pp
	const MAX_CP_DELTA = 60; // 60cp
</script>

<DossierSubpageShell
	title="Repertoire fit"
	subtitle="Per-repertoire performance — same-colour games attributed by FEN-key match against your stored prep tree. Lets you see how the lines you actually prepared score versus games where you went off-book."
	{loaded}
	hasReport={!!result}
>
	{#if baseline && byRepertoire}
		<!-- Baseline -->
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Your baseline
			</div>
			<div class="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Overall win rate</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{pctFmt(baseline.userWinRate)}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Overall avg CP loss</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{baseline.userAvgCpLoss != null ? baseline.userAvgCpLoss.toFixed(1) : '—'}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Games in scan</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{byRepertoire.totalGames}
					</div>
				</div>
			</div>
		</section>

		{#if viewModels.length === 0}
			<section
				class="mt-4 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs text-[var(--color-parchment-500)]">
					No repertoires built yet. Create one from the
					<a class="underline" href={resolve('/')}>home page</a>
					and re-run the dossier scan.
				</div>
			</section>
		{:else}
			<!-- Corpus composition stacked bar -->
			<section
				class="mt-4 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
					Scan composition
				</div>
				<p class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
					How {byRepertoire.totalGames} scanned games split across your repertoires. Width is share of
					corpus.
				</p>
				<div
					class="mt-3 flex h-3 overflow-hidden rounded border border-[var(--color-ink-800)]"
					role="img"
					aria-label="Scan composition stacked bar"
				>
					{#each viewModels as v (v.key)}
						<div
							class={v.isUnattributed
								? 'bg-[var(--color-parchment-500)]/30'
								: repColor(v.paletteIdx)}
							style:width={pctFmt(pctOf(v.games, byRepertoire.totalGames), 2)}
							title="{v.title}: {v.games} games ({pctFmt(
								pctOf(v.games, byRepertoire.totalGames),
								0
							)})"
						></div>
					{/each}
				</div>
				<ul class="mt-3 grid gap-1 text-[11px] sm:grid-cols-2">
					{#each viewModels as v (v.key)}
						<li class="flex items-center gap-2">
							<span
								class="inline-block size-2.5 shrink-0 rounded-sm {v.isUnattributed
									? 'bg-[var(--color-parchment-500)]/40'
									: repColor(v.paletteIdx)}"
							></span>
							<span class="truncate text-[var(--color-parchment-200)]">{v.title}</span>
							<span class="font-mono text-[var(--color-parchment-500)]">
								{v.games} · {pctFmt(pctOf(v.games, byRepertoire.totalGames), 0)}
							</span>
						</li>
					{/each}
				</ul>
			</section>

			<!-- Per-repertoire detail cards -->
			<div class="mt-4 grid gap-3">
				{#each viewModels as v (v.key)}
					{@const total = v.wins + v.draws + v.losses || 1}
					{@const wrBar = divergingBar(v.winRateDelta, MAX_WR_DELTA)}
					{@const cpBar = v.cpDelta != null ? divergingBar(v.cpDelta, MAX_CP_DELTA) : null}
					{@const maxFamilyGames = Math.max(...v.topRows.map((r) => r.games), 1)}
					<section
						class="rounded border px-4 py-4 {v.isUnattributed
							? 'border-dashed border-[var(--color-ink-800)] bg-[var(--color-ink-950)]'
							: 'border-[var(--color-ink-800)] bg-[var(--color-ink-900)]'}"
					>
						<header class="flex flex-wrap items-baseline justify-between gap-2">
							<div class="flex items-center gap-2">
								{#if !v.isUnattributed}
									<span class="inline-block size-3 shrink-0 rounded-sm {repColor(v.paletteIdx)}"
									></span>
								{/if}
								<h2 class="font-serif text-lg text-[var(--color-parchment-50)]">{v.title}</h2>
								{#if v.colorBadge}
									<span
										class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-[var(--color-parchment-400)] uppercase"
									>
										{v.colorBadge}
									</span>
								{/if}
							</div>
							<div class="font-mono text-xs text-[var(--color-parchment-400)]">
								{v.games} games · {pctFmt(pctOf(v.games, byRepertoire.totalGames), 0)} of scan
							</div>
						</header>

						<!-- W/D/L outcome stripe -->
						<div class="mt-4">
							<div
								class="mb-1 flex items-baseline justify-between text-[10px] text-[var(--color-parchment-500)]"
							>
								<span>Outcomes</span>
								<span class="font-mono">{v.wins}W / {v.draws}D / {v.losses}L</span>
							</div>
							<div
								class="flex h-2.5 overflow-hidden rounded"
								role="img"
								aria-label="{v.wins} wins, {v.draws} draws, {v.losses} losses"
							>
								<div class={segmentClass('positive')} style:width={pctFmt(v.wins / total, 2)}></div>
								<div class={segmentClass('neutral')} style:width={pctFmt(v.draws / total, 2)}></div>
								<div
									class={segmentClass('negative')}
									style:width={pctFmt(v.losses / total, 2)}
								></div>
							</div>
						</div>

						<!-- Diverging deltas -->
						<div class="mt-4 grid gap-3 sm:grid-cols-2">
							<!-- Win rate -->
							<div>
								<div
									class="flex items-baseline justify-between text-[10px] text-[var(--color-parchment-500)]"
								>
									<span>Win rate</span>
									<span class="font-mono text-[var(--color-parchment-300)]"
										>{pctFmt(v.winRate)}</span
									>
								</div>
								<div class="mt-1 flex h-2 items-stretch">
									<div class="relative flex-1">
										<div class="absolute inset-y-0 right-0 flex justify-end">
											<div class="rounded-l bg-amber-500/45" style:width={wrBar.left}></div>
										</div>
									</div>
									<div class="w-px bg-[var(--color-ink-700)]"></div>
									<div class="relative flex-1">
										<div class="absolute inset-y-0 left-0 flex">
											<div class="rounded-r bg-emerald-500/45" style:width={wrBar.right}></div>
										</div>
									</div>
								</div>
								<div
									class="mt-1 text-right font-mono text-[11px] {deltaTone(v.winRateDelta, 0.05)}"
								>
									{signedPp(v.winRateDelta)} vs your overall
								</div>
							</div>

							<!-- CP loss -->
							<div>
								<div
									class="flex items-baseline justify-between text-[10px] text-[var(--color-parchment-500)]"
								>
									<span>Avg CP loss</span>
									<span class="font-mono text-[var(--color-parchment-300)]">
										{v.avgCp != null ? v.avgCp.toFixed(1) : '—'}
									</span>
								</div>
								<div class="mt-1 flex h-2 items-stretch">
									<div class="relative flex-1">
										<div class="absolute inset-y-0 right-0 flex justify-end">
											<!-- For CP loss, "left = negative delta = better"; render emerald. -->
											<div
												class="rounded-l bg-emerald-500/45"
												style:width={cpBar?.left ?? '0%'}
											></div>
										</div>
									</div>
									<div class="w-px bg-[var(--color-ink-700)]"></div>
									<div class="relative flex-1">
										<div class="absolute inset-y-0 left-0 flex">
											<div
												class="rounded-r bg-amber-500/45"
												style:width={cpBar?.right ?? '0%'}
											></div>
										</div>
									</div>
								</div>
								<div
									class="mt-1 text-right font-mono text-[11px] {v.cpDelta != null
										? cpDeltaTone(v.cpDelta, 5)
										: 'text-[var(--color-parchment-500)]'}"
								>
									{v.cpDelta != null ? `${signedCp(v.cpDelta)} vs your overall` : 'needs eval'}
								</div>
							</div>
						</div>

						<!-- Top families breakdown -->
						{#if v.topRows.length > 0}
							<div class="mt-4">
								<div
									class="mb-2 text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
								>
									Top families ({v.topRows.length})
								</div>
								<ul class="grid gap-1.5">
									{#each v.topRows as r (`${r.color}|${r.opening}`)}
										<li
											class="grid grid-cols-[minmax(0,1fr)_1fr_3.5rem_3.5rem] items-center gap-2 text-[11px] sm:grid-cols-[minmax(0,12rem)_1fr_3.5rem_4rem]"
										>
											<span class="truncate text-[var(--color-parchment-200)]" title={r.opening}>
												{r.opening}
											</span>
											<div class="h-1.5 rounded bg-[var(--color-ink-950)]">
												<div
													class="h-full rounded bg-[var(--color-brass-300)]/70"
													style:width={pctFmt(r.games / maxFamilyGames, 1)}
												></div>
											</div>
											<span class="text-right font-mono text-[var(--color-parchment-400)]">
												{r.games}g · {pctFmt(r.winRate, 0)}
											</span>
											<span class="text-right font-mono {deltaTone(r.winRateDelta, 0.05)}">
												{signedPp(r.winRateDelta, 0)}
											</span>
										</li>
									{/each}
								</ul>
								<div class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
									Bar = relative game count. Right column = win-rate Δ vs your overall.
								</div>
							</div>
						{:else}
							<div class="mt-4 text-[11px] text-[var(--color-parchment-500)]">
								No family reached the 5-game floor inside this bucket — the games here are spread
								across many small samples.
							</div>
						{/if}

						{#if v.repertoireId}
							<div class="mt-4 flex flex-wrap gap-3 text-[11px]">
								<a
									class="text-[var(--color-brass-300)] hover:underline"
									href={resolve(`/repertoire/${v.repertoireId}`)}
								>
									Open repertoire →
								</a>
								<a
									class="text-[var(--color-brass-300)] hover:underline"
									href={resolve(`/repertoire/${v.repertoireId}/mistakes`)}
								>
									Mistakes inside this rep →
								</a>
							</div>
						{/if}
					</section>
				{/each}
			</div>

			<!-- Methodology footnote -->
			<section
				class="mt-4 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-4 py-3 text-[11px] text-[var(--color-parchment-500)]"
			>
				<strong class="text-[var(--color-parchment-300)]">Method.</strong>
				A game is attributed to the same-colour repertoire whose stored prep tree it visits the most non-root
				user-to-move positions of (FEN-key match, EPD canonicalisation). The root is excluded because
				every same-colour rep starts from the initial position. Games that match no rep land in
				<em>Unattributed</em> — either you didn't have a rep on that side, or you played an opening outside
				your prep. Per-family rows inside each bucket use the same ≥ 5-game floor as the main opening-fit
				page to avoid 1-game noise.
			</section>
		{/if}
	{/if}
</DossierSubpageShell>

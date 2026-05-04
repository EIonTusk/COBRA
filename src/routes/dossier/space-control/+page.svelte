<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import MastersBaselinePanel from '$lib/dossier/MastersBaselinePanel.svelte';
	import SquareHeatBoard from '$lib/dossier/SquareHeatBoard.svelte';
	import Select from '$lib/ui/Select.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import {
		buildSpaceControl,
		type BuildSpaceControlOpts,
		type SpaceControlPerspective,
		type SpaceControlReport,
		type SpaceControlSlice
	} from '$lib/dossier/spaceControl';
	import { parseOpeningName } from '$lib/dossier/openings';
	import type { LoadedMastersBaseline } from '$lib/storage/mastersBaseline';
	import type { DossierScanResult } from '$lib/dossier/scan';
	import type { Phase } from '$lib/dossier/classify';

	const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
	const PHASES: Phase[] = ['opening', 'middle', 'end'];
	const MUTE_THRESHOLD = 0.05;

	// Mirror SquareHeatBoard's internal layout constants so the legend's
	// gradient bar height matches just the 8×8 squares, not the coord-label
	// strip beneath them. Used as a CSS fraction.
	const BOARD_SQ = 56;
	const BOARD_COORD_PAD = 18;
	const BOARD_TOTAL = BOARD_SQ * 8 + BOARD_COORD_PAD;
	const GRID_HEIGHT = BOARD_SQ * 8;

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);
	// Active colour for the single combined heatmap. Per-colour state
	// (phasePos, muteSmall, familyFilter) is keyed by colour so toggling
	// the colour preserves what the user had set on the other side.
	let selectedColor = $state<'white' | 'black'>('white');
	// Per-colour phase position. 0 = opening, 0.5 = middle, 1 = end.
	let phasePos = $state<{ white: number; black: number }>({ white: 0.5, black: 0.5 });
	// Per-colour mute toggle.
	let muteSmall = $state<{ white: boolean; black: boolean }>({ white: false, black: false });
	// One global toggle for "compare against": peers (in-scan opposite-colour
	// games) or masters (cached masters baseline). Per the dossier convention
	// of switching baselines per module, not page-globally.
	let compareMode = $state<'peers' | 'masters'>('peers');
	let mastersBaseline = $state<LoadedMastersBaseline | null>(null);
	// Per-colour opening-family filter. `'all'` keeps the unfiltered global
	// view; selecting a specific family narrows the user-as-X samples to
	// that family while leaving the opposite-colour games untouched so the
	// opp baseline stays representative.
	let familyFilter = $state<{ white: string; black: string }>({ white: 'all', black: 'all' });

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	function buildOpts(): BuildSpaceControlOpts {
		const opts: BuildSpaceControlOpts = {};
		if (compareMode === 'masters' && mastersBaseline?.games.length) {
			opts.comparison = mastersBaseline.games;
		}
		return opts;
	}

	// Family choices per colour, sorted by user-game count desc. Uses the
	// same `parseOpeningName` family root the opening-fit page does so the
	// dropdown labels match the rest of the dossier.
	const familyChoices = $derived.by(() => {
		// Plain object counters — the derived output is a frozen pair of
		// arrays so reactivity over an internal Map would be wasted, and
		// the linter flags raw Map usage in .svelte files anyway.
		const w: Record<string, number> = {};
		const b: Record<string, number> = {};
		if (!result)
			return { white: [] as Array<[string, number]>, black: [] as Array<[string, number]> };
		for (const g of result.classified) {
			const { family } = parseOpeningName(g.openingName, g.eco);
			const counts = g.color === 'white' ? w : b;
			counts[family] = (counts[family] ?? 0) + 1;
		}
		const sorted = (counts: Record<string, number>) =>
			Object.entries(counts).sort((a, b) => b[1] - a[1]);
		return { white: sorted(w), black: sorted(b) };
	});

	function filteredFor(color: 'white' | 'black'): SpaceControlReport | null {
		if (!result) return null;
		const family = familyFilter[color];
		if (family === 'all') return buildSpaceControl(result.classified, buildOpts());
		// Narrow only the user-as-X side; pass through the other colour's
		// games whole so the opp footprint stays at full sample size.
		const filtered = result.classified.filter((g) => {
			if (g.color !== color) return true;
			return parseOpeningName(g.openingName, g.eco).family === family;
		});
		return buildSpaceControl(filtered, buildOpts());
	}

	const whiteSummary = $derived(filteredFor('white'));
	const blackSummary = $derived(filteredFor('black'));

	// Top-level summary used by the coverage strip — always reflects the
	// unfiltered corpus so the totals are stable as the user toggles
	// per-perspective filters.
	const summary = $derived.by(() => {
		if (!result) return null;
		return buildSpaceControl(result.classified, buildOpts());
	});

	const peerWord = $derived(compareMode === 'masters' ? 'masters' : 'peers');
	const sourceWord = $derived(
		compareMode === 'masters' ? 'masters playing the same colour' : 'your same-rating opponents'
	);

	function squareName(sq: number): string {
		return `${FILES[sq & 7]}${(sq >> 3) + 1}`;
	}

	/** Linearly interpolate between adjacent phase slices at slider position t.
	 *  Falls back to the perspective's overall slice when a phase bucket is
	 *  null (thin sample) so the slider stays smooth. */
	interface InterpolatedView {
		diff: number[];
		userAvg: number[];
		oppAvg: number[];
		userSamples: number;
		oppSamples: number;
	}

	function interpolate(p: SpaceControlPerspective, t: number): InterpolatedView {
		const overall: SpaceControlSlice = {
			diff: p.diff,
			diffAvgAttackers: p.diffAvgAttackers,
			user: p.user,
			opponent: p.opponent
		};
		const slices: SpaceControlSlice[] = [
			p.byPhase.opening ?? overall,
			p.byPhase.middle ?? overall,
			p.byPhase.end ?? overall
		];
		let aIdx: number, bIdx: number, frac: number;
		if (t <= 0.5) {
			aIdx = 0;
			bIdx = 1;
			frac = t * 2;
		} else {
			aIdx = 1;
			bIdx = 2;
			frac = (t - 0.5) * 2;
		}
		const a = slices[aIdx];
		const b = slices[bIdx];
		const diff = new Array<number>(64);
		const userAvg = new Array<number>(64);
		const oppAvg = new Array<number>(64);
		for (let i = 0; i < 64; i++) {
			diff[i] = a.diff[i] * (1 - frac) + b.diff[i] * frac;
			userAvg[i] =
				a.user.squares[i].avgAttackers * (1 - frac) + b.user.squares[i].avgAttackers * frac;
			oppAvg[i] =
				a.opponent.squares[i].avgAttackers * (1 - frac) + b.opponent.squares[i].avgAttackers * frac;
		}
		const nearer = frac < 0.5 ? a : b;
		return {
			diff,
			userAvg,
			oppAvg,
			userSamples: nearer.user.samples,
			oppSamples: nearer.opponent.samples
		};
	}

	function phaseLabel(t: number): string {
		if (t <= 0.05) return 'Opening';
		if (t < 0.45) return 'Opening → Middlegame';
		if (t <= 0.55) return 'Middlegame';
		if (t < 0.95) return 'Middlegame → Endgame';
		return 'Endgame';
	}

	function diffLabel(view: InterpolatedView) {
		return (sq: number) => {
			const d = view.diff[sq];
			const u = view.userAvg[sq];
			const o = view.oppAvg[sq];
			const sign = d >= 0 ? '+' : '';
			return `${squareName(sq)} — diff ${sign}${(d * 100).toFixed(1)}pp · you ${u.toFixed(2)} vs ${peerWord} ${o.toFixed(2)} attackers`;
		};
	}

	/** Shared scale across each perspective's overall + every phase, so
	 *  dragging the slider doesn't re-scale the colours under the user's hand. */
	function perspectiveMax(p: SpaceControlPerspective): number {
		let m = 0;
		const collect = (arr: number[]) => {
			for (const v of arr) {
				const a = Math.abs(v);
				if (a > m) m = a;
			}
		};
		collect(p.diff);
		for (const phase of PHASES) {
			const slice = p.byPhase[phase];
			if (slice) collect(slice.diff);
		}
		return m > 0 ? m : 1;
	}

	// Single active perspective driven by the colour selector. Returns a
	// non-null shell even when the chosen filter narrows below the
	// sample threshold, so the dropdowns stay reachable and the user can
	// switch back to "All openings" or to the other colour.
	type PerspectiveEntry = {
		color: 'white' | 'black';
		hasGames: boolean;
		perspective: SpaceControlPerspective | null;
		max: number;
	};
	const activePerspective = $derived.by((): PerspectiveEntry => {
		const color = selectedColor;
		const hasGames = result?.classified.some((g) => g.color === color) ?? false;
		const fromSummary = color === 'white' ? whiteSummary?.white : blackSummary?.black;
		const persp = fromSummary ?? null;
		return {
			color,
			hasGames,
			perspective: persp,
			max: persp ? perspectiveMax(persp) : 1
		};
	});

	const colorOptions: Array<{ value: 'white' | 'black'; label: string }> = [
		{ value: 'white', label: 'White' },
		{ value: 'black', label: 'Black' }
	];

	const familyOptions = $derived.by(() => {
		const choices = familyChoices[selectedColor];
		const total = choices.reduce((s, [, n]) => s + n, 0);
		const out: Array<{ value: string; label: string }> = [
			{ value: 'all', label: `All openings (${total}g)` }
		];
		for (const [family, games] of choices) {
			out.push({ value: family, label: `${family} (${games}g)` });
		}
		return out;
	});
</script>

<DossierSubpageShell
	title="Space control"
	subtitle="Per-square attacker count when you play a colour, compared to how your opponents deploy that same colour in your other-side games."
	{loaded}
	hasReport={!!result}
>
	{#if summary}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="flex flex-wrap items-baseline justify-between gap-3">
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
					Compare against
				</div>
				<div class="inline-flex rounded border border-[var(--color-ink-800)] text-xs">
					<button
						type="button"
						class="px-3 py-1 transition-colors {compareMode === 'peers'
							? 'bg-[var(--color-brass-300)]/20 text-[var(--color-parchment-100)]'
							: 'text-[var(--color-parchment-400)] hover:text-[var(--color-parchment-200)]'}"
						onclick={() => (compareMode = 'peers')}
					>
						Peers
					</button>
					<button
						type="button"
						class="px-3 py-1 transition-colors {compareMode === 'masters'
							? 'bg-[var(--color-brass-300)]/20 text-[var(--color-parchment-100)]'
							: 'text-[var(--color-parchment-400)] hover:text-[var(--color-parchment-200)]'} {!mastersBaseline
							? 'opacity-60'
							: ''}"
						disabled={!mastersBaseline}
						onclick={() => (compareMode = 'masters')}
					>
						Masters{!mastersBaseline ? ' (not loaded)' : ''}
					</button>
				</div>
			</div>

			<div class="mt-3">
				<MastersBaselinePanel {result} bind:baseline={mastersBaseline} />
			</div>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Coverage</div>
			<div class="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Total positions</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.totalPositions.toLocaleString()}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Games contributing</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.games.toLocaleString()}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">As White (you / opp)</div>
					<div class="mt-1 font-mono text-sm text-[var(--color-parchment-100)]">
						{summary.white?.user.samples ?? 0} / {summary.white?.opponent.samples ?? 0}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">As Black (you / opp)</div>
					<div class="mt-1 font-mono text-sm text-[var(--color-parchment-100)]">
						{summary.black?.user.samples ?? 0} / {summary.black?.opponent.samples ?? 0}
					</div>
				</div>
			</div>
		</section>

		{@const p = activePerspective}
		{@const t = phasePos[p.color]}
		{@const tickFmt = (v: number) => `${(v * 100).toFixed(0)}pp`}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Heatmap</div>
				<div class="flex flex-wrap items-center gap-3">
					<label class="flex items-center gap-2 text-[11px] text-[var(--color-parchment-300)]">
						<span class="text-[var(--color-parchment-500)]">When you play</span>
						<Select
							options={colorOptions}
							value={selectedColor}
							onchange={(v) => (selectedColor = v)}
							class="w-28"
						/>
					</label>
					<label class="flex items-center gap-2 text-[11px] text-[var(--color-parchment-300)]">
						<span class="text-[var(--color-parchment-500)]">Opening</span>
						<Select
							options={familyOptions}
							value={familyFilter[selectedColor]}
							onchange={(v) => (familyFilter[selectedColor] = v)}
							class="w-64"
						/>
					</label>
					<label
						class="flex cursor-pointer items-center gap-2 text-[11px] text-[var(--color-parchment-300)]"
					>
						<input
							type="checkbox"
							bind:checked={muteSmall[selectedColor]}
							class="size-4 accent-[var(--color-brass-300)]"
						/>
						Mute &lt; ±{(MUTE_THRESHOLD * 100).toFixed(0)}pp
					</label>
				</div>
			</div>
			<div class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
				vs {sourceWord} · oriented from {p.color === 'white' ? "white's" : "black's"} POV · files
				{p.color === 'white' ? 'a–h' : 'h–a'}
				{#if familyFilter[p.color] !== 'all'}
					· filter <span class="font-mono text-[var(--color-parchment-300)]"
						>{familyFilter[p.color]}</span
					>
				{/if}
			</div>

			{#if !p.hasGames}
				<div
					class="mt-4 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] p-3 text-xs text-[var(--color-parchment-400)]"
				>
					No {p.color} games in this scan — switch to the other side or run a scan that includes both
					colours from the
					<a class="underline" href={resolve('/dossier')}>main report</a>.
				</div>
			{:else if p.perspective}
				{@const view = interpolate(p.perspective, t)}
				<div class="mx-auto mt-4 max-w-[32rem]">
					<div class="flex items-stretch gap-2">
						<!-- Legend wrapper stretches to full board height; inner
						     legend is capped at GRID/BOARD_TOTAL so it lines up
						     with the squares, not the file-label strip. -->
						<div class="flex self-stretch">
							<div
								class="flex"
								style="height: calc(100% * {GRID_HEIGHT} / {BOARD_TOTAL}); align-self: flex-start;"
							>
								<div
									class="flex flex-col justify-between pr-1.5 text-right font-mono text-[10px] text-[var(--color-parchment-400)]"
								>
									<span>+{tickFmt(p.max)}</span>
									<span>0</span>
									<span>{tickFmt(-p.max)}</span>
								</div>
								<svg
									viewBox="0 0 12 100"
									preserveAspectRatio="none"
									class="block w-3 self-stretch rounded-sm"
									aria-hidden="true"
								>
									<defs>
										<linearGradient
											id="space-legend-{p.color}"
											x1="0"
											y1="0"
											x2="0"
											y2="100"
											gradientUnits="userSpaceOnUse"
										>
											<stop offset="0%" stop-color="rgb(194,88,18)" />
											<stop offset="50%" stop-color="rgb(232,227,212)" />
											<stop offset="100%" stop-color="rgb(25,84,130)" />
										</linearGradient>
									</defs>
									<rect
										x="0"
										y="0"
										width="12"
										height="100"
										fill="url(#space-legend-{p.color})"
										stroke="rgba(0,0,0,0.15)"
										stroke-width="0.5"
									/>
								</svg>
							</div>
						</div>

						<div class="min-w-0 flex-1">
							<SquareHeatBoard
								values={view.diff}
								mode="diff"
								orientation={p.color}
								max={p.max}
								threshold={muteSmall[p.color] ? MUTE_THRESHOLD : 0}
								label={diffLabel(view)}
								formatTick={tickFmt}
								legend={false}
							/>
						</div>
					</div>

					<div class="mt-5">
						<div class="flex items-baseline justify-between text-[11px]">
							<span class="text-[var(--color-parchment-500)]">Game phase</span>
							<span class="font-mono text-[var(--color-parchment-200)]">
								{phaseLabel(t)}
								<span class="text-[var(--color-parchment-500)]">
									· {view.userSamples} / {view.oppSamples} samples
								</span>
							</span>
						</div>
						<input
							type="range"
							min="0"
							max="1"
							step="0.01"
							bind:value={phasePos[p.color]}
							class="mt-2 w-full accent-[var(--color-brass-300)]"
							aria-label="Game phase position"
						/>
						<div
							class="mt-1 flex justify-between font-mono text-[10px] text-[var(--color-parchment-500)]"
						>
							<span>Opening</span>
							<span>Middlegame</span>
							<span>Endgame</span>
						</div>
					</div>
				</div>
			{:else}
				<div
					class="mt-4 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] p-3 text-xs text-[var(--color-parchment-400)]"
				>
					Not enough samples for this filter — each perspective needs at least 25 user-as-{p.color}
					and 25 opp-as-{p.color === 'white' ? 'black' : 'white'} positions. Pick a broader family or
					<button
						type="button"
						class="underline hover:text-[var(--color-parchment-100)]"
						onclick={() => (familyFilter[p.color] = 'all')}
					>
						reset to All openings
					</button>.
				</div>
			{/if}
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Methodology</div>
			<p class="mt-2 text-xs leading-relaxed text-[var(--color-parchment-400)]">
				One sample is collected at every position where it was your turn to move. For that position
				we count, per square, how many of each side's pieces attack it (sliding pieces respect
				blockers; pawn attack direction follows colour). Each sample is filed under whichever colour
				it pertains to: in your white games we record the white-army footprint as "user-as-white"
				and the black-army footprint as "opp-as-black"; in your black games we record the black-army
				footprint as "user-as-black" and the white-army footprint as "opp-as-white".
			</p>
			<p class="mt-2 text-xs leading-relaxed text-[var(--color-parchment-400)]">
				The diff for each colour compares like for like — your white army vs your opponents' white
				army, both sampled from your own scan (so opponents are at a comparable rating band by
				construction). Each comparison is also bucketed by phase using the same opening/middle/end
				classifier the rest of the dossier uses (opening = first ~12 full moves; endgame = both
				sides' non-pawn material ≤ 13). The slider linearly interpolates between adjacent phase
				diffs as you drag it from opening to endgame, so the heatmap reads as a continuous
				transition rather than three discrete snapshots. Phase buckets with fewer than 15
				same-colour samples on either side fall back to the perspective's all-phase aggregate at
				that slider position.
			</p>
			<p class="mt-2 text-xs leading-relaxed text-[var(--color-parchment-400)]">
				Underlying square indices stay in canonical chess coordinates; the black board is rotated
				180° purely for display so the acting army sits at the bottom and the file/rank labels track
				the over-the-board view. The "mute small differences" toggle clamps any square with a diff
				under ±{(MUTE_THRESHOLD * 100).toFixed(0)}pp to the neutral colour, so the eye lands on the
				larger asymmetries.
			</p>
			<p class="mt-2 text-xs leading-relaxed text-[var(--color-parchment-400)]">
				Caveats: opponent samples are drawn from your other-colour games, so the position
				distributions differ — your 1.d4 white games and your opponents' 1.e4 white games (faced
				when you played black) are not the same opening pool. There is also a half-tempo offset:
				your samples are at "your-side-to-move" positions, opponents' samples are at "their-side-
				to-move" in the other game. Per-opening splits remain deferred until the overall signal
				proves itself.
			</p>
		</section>
	{:else if loaded && result}
		<div class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-4">
			<p class="text-sm text-[var(--color-parchment-200)]">Not enough data.</p>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				Space control needs at least 50 sampled positions, including at least 25 of each colour
				combination. Run a larger scan from the
				<a class="underline" href={resolve('/dossier')}>main report</a>.
			</p>
		</div>
	{/if}
</DossierSubpageShell>

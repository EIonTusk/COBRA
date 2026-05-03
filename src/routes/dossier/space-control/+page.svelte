<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import SquareHeatBoard from '$lib/dossier/SquareHeatBoard.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import {
		buildSpaceControl,
		type SpaceControlPerspective,
		type SpaceControlSlice
	} from '$lib/dossier/spaceControl';
	import type { DossierScanResult } from '$lib/dossier/scan';
	import type { Phase } from '$lib/dossier/classify';

	const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
	const PHASES: Phase[] = ['opening', 'middle', 'end'];
	const MUTE_THRESHOLD = 0.05;

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);
	// Per-perspective phase position. 0 = opening, 0.5 = middle, 1 = end.
	let phasePos = $state<{ white: number; black: number }>({ white: 0.5, black: 0.5 });
	// Per-perspective mute toggle.
	let muteSmall = $state<{ white: boolean; black: boolean }>({ white: false, black: false });

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(result ? buildSpaceControl(result.classified) : null);

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
			return `${squareName(sq)} — diff ${sign}${(d * 100).toFixed(1)}pp · you ${u.toFixed(2)} vs peers ${o.toFixed(2)} attackers`;
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

	const perspectives = $derived.by(() => {
		if (!summary) return [];
		const out: Array<{
			color: 'white' | 'black';
			label: string;
			perspective: SpaceControlPerspective;
			max: number;
		}> = [];
		if (summary.white)
			out.push({
				color: 'white',
				label: 'When you play White',
				perspective: summary.white,
				max: perspectiveMax(summary.white)
			});
		if (summary.black)
			out.push({
				color: 'black',
				label: 'When you play Black',
				perspective: summary.black,
				max: perspectiveMax(summary.black)
			});
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

		{#if perspectives.length === 0}
			<div class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-4">
				<p class="text-sm text-[var(--color-parchment-200)]">
					Not enough same-colour samples on either side.
				</p>
				<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
					Each perspective needs at least 25 user-as-X and 25 opponent-as-X positions. Run a larger
					scan or one that mixes both colours from the
					<a class="underline" href={resolve('/dossier')}>main report</a>.
				</p>
			</div>
		{/if}

		{#each perspectives as p (p.color)}
			{@const t = phasePos[p.color]}
			{@const view = interpolate(p.perspective, t)}
			{@const tickFmt = (v: number) => `${(v * 100).toFixed(0)}pp`}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="flex flex-wrap items-baseline justify-between gap-3">
					<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
						{p.label}
					</div>
					<label
						class="flex cursor-pointer items-center gap-2 text-[11px] text-[var(--color-parchment-300)]"
					>
						<input
							type="checkbox"
							bind:checked={muteSmall[p.color]}
							class="size-3.5 accent-[var(--color-brass-300)]"
						/>
						Mute &lt; ±{(MUTE_THRESHOLD * 100).toFixed(0)}pp
					</label>
				</div>
				<div class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
					oriented from {p.color === 'white' ? "white's" : "black's"} POV · files
					{p.color === 'white' ? 'a–h' : 'h–a'}
				</div>

				<div class="mx-auto mt-4 max-w-[32rem]">
					<div class="flex items-stretch gap-3">
						<div class="flex items-stretch py-1">
							<div
								class="flex flex-col justify-between pr-2 text-right font-mono text-[10px] text-[var(--color-parchment-400)]"
							>
								<span>+{tickFmt(p.max)}</span>
								<span>0</span>
								<span>{tickFmt(-p.max)}</span>
							</div>
							<div
								class="w-3 self-stretch rounded-sm border border-[rgba(0,0,0,0.15)]"
								style="background: linear-gradient(to top, rgb(25,84,130) 0%, rgb(232,227,212) 50%, rgb(194,88,18) 100%)"
							></div>
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
			</section>
		{/each}

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

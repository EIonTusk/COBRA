<script lang="ts">
	/**
	 * Pure-SVG chess heatmap. 8×8 grid where every square is a solid colour
	 * sampled from a colormap, so the gradient reads uniformly across the
	 * board (no chequerboard underneath to interfere with luminance
	 * comparison). Two modes:
	 *   - `diff`     divergent palette (cool → neutral → warm)
	 *   - `absolute` sequential palette (neutral → warm)
	 *
	 * Values are indexed in canonical chessops layout (a1=0 .. h8=63). The
	 * `orientation` prop applies a purely visual 180° rotation for the
	 * black perspective — files (h-a) and ranks (8-1) both flip — so the
	 * acting army sits at the bottom of the board. An inline legend strip
	 * beneath the board labels the scale end-points so readers can decode
	 * squares without hovering.
	 */
	interface Props {
		values: number[];
		mode: 'diff' | 'absolute';
		/** Board orientation. `white` = a1 bottom-left (default); `black`
		 *  = full 180° rotation, h8 bottom-left, files h-a left-to-right,
		 *  ranks 8-1 bottom-to-top. `values` is always indexed in canonical
		 *  chessops layout (a1=0 .. h8=63) — the rotation is purely visual. */
		orientation?: 'white' | 'black';
		/** Max absolute value used for colour normalisation. Defaults to the
		 *  data's own peak (so a single board self-scales). */
		max?: number;
		/** Squares with |value| below this threshold render as neutral.
		 *  Useful for muting noise so the eye lands on the real signal. */
		threshold?: number;
		/** Optional per-square hover tooltip (rendered as SVG `<title>`). */
		label?: (sq: number) => string;
		/** Formatter for the legend tick labels (-max, 0, +max). */
		formatTick?: (v: number) => string;
		coordinates?: boolean;
		legend?: boolean;
	}

	const SQUARES: number[] = Array.from({ length: 64 }, (_, i) => i);
	const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
	const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'];
	const SQ = 56;
	const COORD_PAD = 18;
	const LEGEND_GAP = 14;
	const LEGEND_HEIGHT = 10;
	const LEGEND_LABEL_HEIGHT = 14;

	// Perceptually balanced divergent palette: muted parchment neutral so
	// near-zero diffs read as "background", with deep amber and deep slate
	// at the extremes. Sequential mode runs neutral → amber only.
	const NEUTRAL: [number, number, number] = [232, 227, 212];
	const WARM: [number, number, number] = [194, 88, 18];
	const COOL: [number, number, number] = [25, 84, 130];

	let {
		values,
		mode,
		orientation = 'white',
		max,
		threshold = 0,
		label,
		formatTick = (v) => v.toFixed(2),
		coordinates = true,
		legend = true
	}: Props = $props();

	const norm = $derived.by(() => {
		if (max != null && max > 0) return max;
		let m = 0;
		for (const v of values) {
			const a = Math.abs(v);
			if (a > m) m = a;
		}
		return m > 0 ? m : 1;
	});

	const pad = $derived(coordinates ? COORD_PAD : 0);
	const boardWidth = $derived(SQ * 8 + pad);
	const boardHeight = $derived(SQ * 8 + pad);
	const totalHeight = $derived(
		boardHeight + (legend ? LEGEND_GAP + LEGEND_HEIGHT + LEGEND_LABEL_HEIGHT : 0)
	);

	function svgX(sq: number, padding: number, orient: 'white' | 'black'): number {
		const file = sq & 7;
		const displayFile = orient === 'white' ? file : 7 - file;
		return displayFile * SQ + padding;
	}

	function svgY(sq: number, orient: 'white' | 'black'): number {
		const rank = sq >> 3;
		const displayRank = orient === 'white' ? 7 - rank : rank;
		return displayRank * SQ;
	}

	function lerp(a: number, b: number, t: number): number {
		return Math.round(a + (b - a) * t);
	}

	function colorFor(value: number, normMax: number): string {
		if (threshold > 0 && Math.abs(value) < threshold) {
			return `rgb(${NEUTRAL.join(',')})`;
		}
		if (mode === 'absolute') {
			const t = Math.min(1, Math.max(0, value) / normMax);
			return `rgb(${lerp(NEUTRAL[0], WARM[0], t)}, ${lerp(NEUTRAL[1], WARM[1], t)}, ${lerp(NEUTRAL[2], WARM[2], t)})`;
		}
		const t = Math.min(1, Math.abs(value) / normMax);
		const target = value >= 0 ? WARM : COOL;
		return `rgb(${lerp(NEUTRAL[0], target[0], t)}, ${lerp(NEUTRAL[1], target[1], t)}, ${lerp(NEUTRAL[2], target[2], t)})`;
	}

	const legendId = `heat-grad-${Math.random().toString(36).slice(2, 8)}`;
	const legendStops = $derived.by(() => {
		if (mode === 'absolute') {
			return [
				{ offset: '0%', color: `rgb(${NEUTRAL.join(',')})` },
				{ offset: '100%', color: `rgb(${WARM.join(',')})` }
			];
		}
		return [
			{ offset: '0%', color: `rgb(${COOL.join(',')})` },
			{ offset: '50%', color: `rgb(${NEUTRAL.join(',')})` },
			{ offset: '100%', color: `rgb(${WARM.join(',')})` }
		];
	});
</script>

<svg
	viewBox="0 0 {boardWidth} {totalHeight}"
	class="block h-auto w-full"
	role="img"
	aria-label="Chess board heatmap"
>
	{#if legend}
		<defs>
			<linearGradient id={legendId} x1="0%" y1="0%" x2="100%" y2="0%">
				{#each legendStops as stop, i (i)}
					<stop offset={stop.offset} stop-color={stop.color} />
				{/each}
			</linearGradient>
		</defs>
	{/if}

	{#each SQUARES as sq (sq)}
		<rect
			x={svgX(sq, pad, orientation)}
			y={svgY(sq, orientation)}
			width={SQ}
			height={SQ}
			fill={colorFor(values[sq] ?? 0, norm)}
			stroke="rgba(0,0,0,0.08)"
			stroke-width="1"
		>
			{#if label}<title>{label(sq)}</title>{/if}
		</rect>
	{/each}

	{#if coordinates}
		{@const ranksDisplay = orientation === 'white' ? RANKS : [...RANKS].reverse()}
		{@const filesDisplay = orientation === 'white' ? FILES : [...FILES].reverse()}
		{#each ranksDisplay as r, i (r)}
			<text
				x={pad - 4}
				y={(7 - i) * SQ + SQ / 2 + 4}
				text-anchor="end"
				class="fill-[var(--color-parchment-500)] font-mono text-[12px]"
			>
				{r}
			</text>
		{/each}
		{#each filesDisplay as f, i (f)}
			<text
				x={i * SQ + SQ / 2 + pad}
				y={SQ * 8 + 14}
				text-anchor="middle"
				class="fill-[var(--color-parchment-500)] font-mono text-[12px]"
			>
				{f}
			</text>
		{/each}
	{/if}

	{#if legend}
		{@const ly = boardHeight + LEGEND_GAP}
		{@const lx = pad}
		{@const lw = SQ * 8}
		<rect
			x={lx}
			y={ly}
			width={lw}
			height={LEGEND_HEIGHT}
			fill="url(#{legendId})"
			stroke="rgba(0,0,0,0.15)"
			stroke-width="1"
		/>
		{#if mode === 'diff'}
			<text
				x={lx}
				y={ly + LEGEND_HEIGHT + 12}
				text-anchor="start"
				class="fill-[var(--color-parchment-500)] font-mono text-[11px]"
			>
				{formatTick(-norm)}
			</text>
			<text
				x={lx + lw / 2}
				y={ly + LEGEND_HEIGHT + 12}
				text-anchor="middle"
				class="fill-[var(--color-parchment-500)] font-mono text-[11px]"
			>
				0
			</text>
			<text
				x={lx + lw}
				y={ly + LEGEND_HEIGHT + 12}
				text-anchor="end"
				class="fill-[var(--color-parchment-500)] font-mono text-[11px]"
			>
				+{formatTick(norm)}
			</text>
		{:else}
			<text
				x={lx}
				y={ly + LEGEND_HEIGHT + 12}
				text-anchor="start"
				class="fill-[var(--color-parchment-500)] font-mono text-[11px]"
			>
				0
			</text>
			<text
				x={lx + lw}
				y={ly + LEGEND_HEIGHT + 12}
				text-anchor="end"
				class="fill-[var(--color-parchment-500)] font-mono text-[11px]"
			>
				{formatTick(norm)}
			</text>
		{/if}
	{/if}
</svg>

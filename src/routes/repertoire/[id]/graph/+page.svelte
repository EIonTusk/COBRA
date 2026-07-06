<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { ArrowLeft, ZoomIn, ZoomOut, Maximize, Shuffle, Plus, Minus } from 'lucide-svelte';

	import { getRepertoire } from '$lib/storage/repertoires';
	import { nodesMap } from '$lib/storage/nodes';
	import { buildGraphLayout } from '$lib/tree/graphLayout';
	import MiniBoard from '$lib/chess/MiniBoard.svelte';
	import type { Repertoire, RepertoireNode } from '$lib/types';

	let rep = $state<Repertoire | null>(null);
	let nodes = $state<Map<string, RepertoireNode>>(new Map());
	let loading = $state(true);

	// Board size and the spacing between columns (plies) and rows.
	const SIZE = 84;
	const PITCH_X = SIZE + 96;
	const PITCH_Y = SIZE + 34;
	const PAD = 48;

	// Collapsed positions — their subtree is hidden and drawn as one node.
	// SvelteSet is already reactive; mutations re-run the layout derived.
	const collapsedSet = new SvelteSet<string>();
	function toggleCollapse(fenKey: string) {
		if (collapsedSet.has(fenKey)) collapsedSet.delete(fenKey);
		else collapsedSet.add(fenKey);
	}

	const layout = $derived(
		rep ? buildGraphLayout(nodes, rep.rootFenKey, { collapsed: collapsedSet }) : null
	);

	// Back target follows where you came from: the editor's tree view passes
	// `?from=edit`; everywhere else (the overview card) returns to the overview.
	const cameFromEditor = $derived(page.url.searchParams.get('from') === 'edit');
	const backLabel = $derived(cameFromEditor ? 'Editor' : (rep?.name ?? ''));

	// Pixel position of each node's top-left corner, keyed by fenKey.
	const posByKey = $derived.by(() => {
		const m = new SvelteMap<string, { x: number; y: number }>();
		for (const n of layout?.nodes ?? []) {
			m.set(n.fenKey, { x: PAD + n.ply * PITCH_X, y: PAD + n.row * PITCH_Y });
		}
		return m;
	});

	// The primary move (SAN + UCI) that reaches each position. SAN labels the
	// low-zoom markers; UCI drives the last-move highlight on each board.
	const inMoveByKey = $derived.by(() => {
		const m = new SvelteMap<string, { san: string; uci: string }>();
		for (const e of layout?.edges ?? []) {
			if (!e.transposition && !m.has(e.toFenKey)) m.set(e.toFenKey, { san: e.san, uci: e.uci });
		}
		return m;
	});
	function lastMoveOf(fenKey: string): [string, string] | undefined {
		const uci = inMoveByKey.get(fenKey)?.uci;
		if (!uci || uci.length < 4) return undefined;
		return [uci.slice(0, 2), uci.slice(2, 4)];
	}

	const canvasW = $derived(PAD * 2 + (layout?.maxPly ?? 0) * PITCH_X + SIZE);
	const canvasH = $derived.by(() => {
		let maxRow = 0;
		for (const n of layout?.nodes ?? []) maxRow = Math.max(maxRow, n.row);
		return PAD * 2 + maxRow * PITCH_Y + SIZE;
	});

	// Precomputed edge geometry: a curve from the right edge of the parent to
	// the left edge of the child, plus a mid-point for the SAN label. Endpoint
	// keys/bbox are kept so edges can be culled with the nodes.
	interface EdgeGeom {
		id: string;
		fromKey: string;
		toKey: string;
		path: string;
		labelX: number;
		labelY: number;
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
		san: string;
		transposition: boolean;
		disabled: boolean;
	}
	const edgeGeoms = $derived.by<EdgeGeom[]>(() => {
		const out: EdgeGeom[] = [];
		for (const e of layout?.edges ?? []) {
			const a = posByKey.get(e.fromFenKey);
			const b = posByKey.get(e.toFenKey);
			if (!a || !b) continue;
			const x1 = a.x + SIZE;
			const y1 = a.y + SIZE / 2;
			const x2 = b.x;
			const y2 = b.y + SIZE / 2;
			const mx = (x1 + x2) / 2;
			out.push({
				id: `${e.fromFenKey}->${e.toFenKey}`,
				fromKey: e.fromFenKey,
				toKey: e.toFenKey,
				path: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
				labelX: x1 + (x2 - x1) * 0.42,
				labelY: y1 + (y2 - y1) * 0.42,
				minX: Math.min(x1, x2),
				minY: Math.min(y1, y2),
				maxX: Math.max(x1, x2),
				maxY: Math.max(y1, y2),
				san: e.san,
				transposition: e.transposition,
				disabled: e.disabled
			});
		}
		return out;
	});

	// ── Pan & zoom ────────────────────────────────────────────────────────
	let viewport = $state<HTMLElement | null>(null);
	let vpW = $state(0);
	let vpH = $state(0);
	let scale = $state(1);
	let tx = $state(0);
	let ty = $state(0);
	let dragging = $state(false);
	let dragMoved = 0;
	let startX = 0;
	let startY = 0;
	let panX0 = 0;
	let panY0 = 0;
	let didFit = false;

	// Below this zoom the boards would be too small to read (and expensive to
	// mount 32 pieces each), so we swap them for lightweight node markers and
	// only render the real chessboards once zoomed in past the threshold.
	const BOARD_ZOOM = 0.55;
	const showBoards = $derived(scale >= BOARD_ZOOM);

	// Visible world rectangle (canvas coordinates), padded so nodes just off
	// screen are already mounted when they pan into view.
	const viewRect = $derived.by(() => {
		const margin = SIZE * 2.5;
		return {
			left: -tx / scale - margin,
			top: -ty / scale - margin,
			right: (vpW - tx) / scale + margin,
			bottom: (vpH - ty) / scale + margin
		};
	});

	// Only the nodes currently in (or near) view are rendered.
	const visibleNodes = $derived.by(() => {
		if (!layout) return [];
		const r = viewRect;
		return layout.nodes.filter((n) => {
			const p = posByKey.get(n.fenKey);
			if (!p) return false;
			return p.x + SIZE >= r.left && p.x <= r.right && p.y + SIZE >= r.top && p.y <= r.bottom;
		});
	});

	// Edges whose bounding box overlaps the view — drawn only when there's
	// something to connect and only labelled once boards are shown.
	const visibleEdges = $derived.by(() => {
		const r = viewRect;
		return edgeGeoms.filter(
			(g) => g.maxX >= r.left && g.minX <= r.right && g.maxY >= r.top && g.minY <= r.bottom
		);
	});

	const clampScale = (s: number) => Math.min(2.5, Math.max(0.12, s));

	function zoomAt(cx: number, cy: number, factor: number) {
		const next = clampScale(scale * factor);
		const wx = (cx - tx) / scale;
		const wy = (cy - ty) / scale;
		tx = cx - wx * next;
		ty = cy - wy * next;
		scale = next;
	}

	function zoomButton(factor: number) {
		if (!viewport) return;
		const r = viewport.getBoundingClientRect();
		zoomAt(r.width / 2, r.height / 2, factor);
	}

	// Keyboard: +/- zoom the graph (about its centre).
	function onKey(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (e.key === '+' || e.key === '=') {
			e.preventDefault();
			zoomButton(1.2);
		} else if (e.key === '-' || e.key === '_') {
			e.preventDefault();
			zoomButton(1 / 1.2);
		}
	}

	function fit() {
		if (!viewport) return;
		const r = viewport.getBoundingClientRect();
		if (canvasW <= 0 || canvasH <= 0) return;
		const s = clampScale(Math.min(r.width / canvasW, r.height / canvasH) * 0.94);
		scale = s;
		tx = (r.width - canvasW * s) / 2;
		ty = Math.max(PAD / 2, (r.height - canvasH * s) / 2);
	}

	// Capture is deferred until the pointer actually moves: a plain click on a
	// board must reach its <a> and navigate, and capturing on pointerdown would
	// steal that click. Once a real drag starts we capture so panning survives
	// the pointer leaving the viewport.
	let captured = false;

	function onPointerDown(e: PointerEvent) {
		dragging = true;
		dragMoved = 0;
		captured = false;
		startX = e.clientX;
		startY = e.clientY;
		panX0 = tx;
		panY0 = ty;
	}
	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		dragMoved = Math.max(dragMoved, Math.abs(dx) + Math.abs(dy));
		if (!captured && dragMoved > 4) {
			captured = true;
			try {
				viewport?.setPointerCapture(e.pointerId);
			} catch {
				// capture is best-effort; panning still works without it.
			}
		}
		tx = panX0 + dx;
		ty = panY0 + dy;
	}
	function onPointerUp(e: PointerEvent) {
		dragging = false;
		if (captured) {
			captured = false;
			try {
				viewport?.releasePointerCapture(e.pointerId);
			} catch {
				// pointer capture may already be gone; harmless.
			}
		}
	}
	function onWheel(e: WheelEvent) {
		if (!viewport) return;
		e.preventDefault();
		const r = viewport.getBoundingClientRect();
		zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
	}
	// Suppress navigation when the click was really the tail of a pan.
	function onNodeClick(e: MouseEvent) {
		if (dragMoved > 6) e.preventDefault();
	}

	// Auto-fit once, after the layout and viewport are both ready.
	$effect(() => {
		if (didFit || !viewport || !layout || layout.nodes.length === 0) return;
		didFit = true;
		fit();
	});

	onMount(async () => {
		const id = page.params.id;
		if (!id) {
			loading = false;
			return;
		}
		rep = (await getRepertoire(id)) ?? null;
		if (rep) nodes = await nodesMap(rep.id);
		loading = false;
	});
</script>

<svelte:window onkeydown={onKey} />

<!-- Fill the viewport below the global app header (h-14 / 3.5rem). -->
<div class="flex h-[calc(100dvh-3.5rem)] flex-col">
	<!-- Header: back link + title + controls. Kept compact so the canvas
		 gets nearly the whole viewport. -->
	<header
		class="flex flex-wrap items-center gap-3 border-b border-[var(--color-ink-800)] px-4 py-3 md:px-6"
	>
		{#if rep}
			<a
				href={cameFromEditor
					? resolve(`/repertoire/${rep.id}/edit`)
					: resolve(`/repertoire/${rep.id}`)}
				class="inline-flex items-center gap-1.5 text-sm text-[var(--color-parchment-400)] transition-colors hover:text-[var(--color-parchment-100)]"
			>
				<ArrowLeft class="size-4" />
				<span class="max-w-[200px] truncate">{backLabel}</span>
			</a>
			<span class="text-[var(--color-ink-600)]">/</span>
			<h1 class="font-serif text-lg tracking-tight">Graph</h1>
			{#if layout}
				<span class="font-mono text-[11px] text-[var(--color-parchment-600)] tabular-nums">
					{layout.nodes.length} positions{layout.capped ? ' (capped)' : ''}
				</span>
			{/if}
		{/if}

		<div class="ml-auto flex items-center gap-1">
			<button
				type="button"
				onclick={() => zoomButton(1 / 1.2)}
				title="Zoom out"
				class="flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)]"
			>
				<ZoomOut class="size-4" />
			</button>
			<button
				type="button"
				onclick={() => zoomButton(1.2)}
				title="Zoom in"
				class="flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)]"
			>
				<ZoomIn class="size-4" />
			</button>
			<button
				type="button"
				onclick={fit}
				title="Fit to view"
				class="flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)]"
			>
				<Maximize class="size-4" />
			</button>
		</div>
	</header>

	{#if loading}
		<div class="flex flex-1 items-center justify-center text-[var(--color-parchment-500)]">
			Loading…
		</div>
	{:else if !rep}
		<div class="flex flex-1 items-center justify-center text-[var(--color-parchment-500)]">
			Repertoire not found.
		</div>
	{:else if !layout || layout.nodes.length === 0}
		<div
			class="flex flex-1 flex-col items-center justify-center gap-2 text-[var(--color-parchment-500)]"
		>
			<p class="font-serif italic">This repertoire has no moves yet.</p>
			<a
				href={resolve(`/repertoire/${rep.id}/edit`)}
				class="text-sm text-[var(--color-brass-300)] hover:underline">Open the builder →</a
			>
		</div>
	{:else}
		<div
			bind:this={viewport}
			bind:clientWidth={vpW}
			bind:clientHeight={vpH}
			role="application"
			aria-label="Repertoire graph — drag to pan, scroll to zoom"
			class="relative flex-1 touch-none overflow-hidden bg-[var(--color-ink-950)] select-none"
			style:cursor={dragging ? 'grabbing' : 'grab'}
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}
			onwheel={onWheel}
		>
			<div
				class="absolute top-0 left-0 origin-top-left"
				style:width="{canvasW}px"
				style:height="{canvasH}px"
				style:transform="translate({tx}px, {ty}px) scale({scale})"
			>
				<!-- Edges behind the boards. -->
				<svg
					class="pointer-events-none absolute top-0 left-0"
					width={canvasW}
					height={canvasH}
					viewBox="0 0 {canvasW} {canvasH}"
					fill="none"
				>
					{#each visibleEdges as g (g.id)}
						<path
							d={g.path}
							stroke={g.transposition ? 'var(--color-brass-400)' : 'var(--color-parchment-400)'}
							stroke-width={g.transposition ? 2 : 2.5}
							stroke-dasharray={g.transposition || g.disabled ? '6 5' : undefined}
							opacity={g.disabled ? 0.45 : 0.9}
						/>
					{/each}
					{#if showBoards}
						{#each visibleEdges as g (g.id + ':label')}
							{#if !g.transposition}
								<text
									x={g.labelX}
									y={g.labelY - 4}
									text-anchor="middle"
									class="fill-[var(--color-parchment-500)]"
									style="font-family: var(--font-mono, monospace); font-size: 12px;"
								>
									{g.san}
								</text>
							{/if}
						{/each}
					{/if}
				</svg>

				<!-- Position nodes. Real chessboards once zoomed in; lightweight
					 markers when zoomed out (culled to the viewport either way). -->
				{#each visibleNodes as n (n.fenKey)}
					{@const p = posByKey.get(n.fenKey)}
					{#if p}
						<div class="absolute" style:left="{p.x}px" style:top="{p.y}px" style:width="{SIZE}px">
							{#if showBoards}
								<a
									href={resolve(`/repertoire/${rep.id}/edit?jump=${encodeURIComponent(n.fenKey)}`)}
									onclick={onNodeClick}
									title={n.isRoot
										? 'Starting position'
										: `${inMoveByKey.get(n.fenKey)?.san ?? ''} — open in the builder`}
									class="board-link block rounded-[4px] outline-none"
									class:is-root={n.isRoot}
									class:is-collapsed={n.collapsed}
								>
									<MiniBoard
										fen={n.fenKey}
										orientation={rep.color}
										size={SIZE}
										lastMove={lastMoveOf(n.fenKey)}
									/>
								</a>
								{#if n.hasChildren}
									<button
										type="button"
										onclick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											toggleCollapse(n.fenKey);
										}}
										title={n.collapsed
											? `Expand ${n.hiddenCount} hidden position${n.hiddenCount === 1 ? '' : 's'}`
											: 'Collapse this line'}
										aria-label={n.collapsed ? 'Expand subtree' : 'Collapse subtree'}
										class="collapse-toggle"
										class:is-collapsed={n.collapsed}
									>
										{#if n.collapsed}
											<Plus class="size-3" strokeWidth={2.5} />
											<span class="tabular-nums">{n.hiddenCount}</span>
										{:else}
											<Minus class="size-3" strokeWidth={2.5} />
										{/if}
									</button>
								{/if}
							{:else}
								<a
									href={resolve(`/repertoire/${rep.id}/edit?jump=${encodeURIComponent(n.fenKey)}`)}
									onclick={onNodeClick}
									title={inMoveByKey.get(n.fenKey)?.san ?? 'start'}
									aria-label={inMoveByKey.get(n.fenKey)?.san ?? 'start'}
									class="node-dot block"
									class:is-root={n.isRoot}
									style:height="{SIZE}px"
								></a>
							{/if}
						</div>
					{/if}
				{/each}
			</div>

			<!-- Legend -->
			<div
				class="pointer-events-none absolute right-3 bottom-3 flex items-center gap-3 rounded-[4px] border border-[var(--color-ink-800)] bg-[var(--color-ink-900)]/90 px-3 py-1.5 font-mono text-[11px] text-[var(--color-parchment-500)]"
			>
				<span class="inline-flex items-center gap-1">
					<Shuffle class="size-3 text-[var(--color-brass-400)]" /> transposition
				</span>
			</div>
		</div>
	{/if}
</div>

<style>
	.board-link {
		box-shadow: 0 0 0 1px var(--color-ink-700);
		transition:
			box-shadow 150ms ease,
			transform 150ms ease;
	}
	.board-link:hover,
	.board-link:focus-visible {
		box-shadow: 0 0 0 2px var(--color-brass-400);
		transform: translateY(-2px);
	}
	.board-link.is-root {
		box-shadow: 0 0 0 2px var(--color-brass-500);
	}
	/* Collapsed board: a stacked-cards shadow hints at the hidden subtree. */
	.board-link.is-collapsed {
		box-shadow:
			0 0 0 1px var(--color-ink-700),
			5px 5px 0 -1px var(--color-ink-800),
			9px 9px 0 -2px var(--color-ink-850);
	}
	.board-link.is-collapsed:hover,
	.board-link.is-collapsed:focus-visible {
		box-shadow:
			0 0 0 2px var(--color-brass-400),
			5px 5px 0 -1px var(--color-ink-800),
			9px 9px 0 -2px var(--color-ink-850);
	}

	/* Collapse / expand pill, hung just off the board's right edge (where the
	   hidden subtree would unfold). Brass with a count when collapsed. */
	.collapse-toggle {
		position: absolute;
		top: 50%;
		right: -0.7rem;
		transform: translateY(-50%);
		z-index: 4;
		display: inline-flex;
		align-items: center;
		gap: 1px;
		height: 1.15rem;
		min-width: 1.15rem;
		justify-content: center;
		padding: 0 0.2rem;
		border-radius: 999px;
		background: var(--color-ink-800);
		color: var(--color-parchment-200);
		box-shadow: 0 0 0 1px var(--color-ink-600);
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		line-height: 1;
		cursor: pointer;
		transition:
			background 150ms ease,
			color 150ms ease;
	}
	.collapse-toggle:hover {
		background: var(--color-ink-700);
		color: var(--color-parchment-50);
	}
	.collapse-toggle.is-collapsed {
		background: var(--color-brass-500);
		color: var(--color-ink-950);
		box-shadow: 0 0 0 1px var(--color-brass-400);
	}

	/* Zoomed-out marker: a board-shaped block so the graph keeps its shape
	   without mounting 32 pieces per node. */
	.node-dot {
		width: 100%;
		border-radius: 4px;
		background: var(--color-ink-700);
		box-shadow: 0 0 0 1px var(--color-ink-600);
		transition:
			background 150ms ease,
			box-shadow 150ms ease;
	}
	.node-dot:hover,
	.node-dot:focus-visible {
		background: var(--color-ink-600);
		box-shadow: 0 0 0 2px var(--color-brass-400);
		outline: none;
	}
	.node-dot.is-root {
		background: var(--color-brass-500);
		box-shadow: 0 0 0 2px var(--color-brass-500);
	}
</style>

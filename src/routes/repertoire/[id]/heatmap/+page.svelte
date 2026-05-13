<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { ArrowLeft, Flame } from 'lucide-svelte';
	import type { DrawShape } from '@lichess-org/chessground/draw';
	import type { Key } from '@lichess-org/chessground/types';

	import Board from '$lib/chess/Board.svelte';
	import { colorToMove } from '$lib/chess/fen';
	import { getRepertoire } from '$lib/storage/repertoires';
	import { listMiddlegameGuides } from '$lib/storage/middlegameGuides';
	import { nodesMap } from '$lib/storage/nodes';
	import { pathToFenKey } from '$lib/tree/traversal';
	import { Button } from '$lib/ui';
	import type { Color, Repertoire, SavedAttackSquare, SavedMiddlegameGuide } from '$lib/types';

	type AttackerFilter = 'both' | 'white' | 'black';

	interface GuideRow {
		guide: SavedMiddlegameGuide;
		lineSans: string[];
	}

	let rep = $state<Repertoire | null>(null);
	let rows = $state<GuideRow[]>([]);
	let loading = $state(true);
	let selectedFenKey = $state<string | null>(null);
	let filter = $state<AttackerFilter>('both');
	let minPctPercent = $state(15);

	const selected = $derived.by<GuideRow | null>(() => {
		if (!selectedFenKey) return null;
		return rows.find((r) => r.guide.fenKey === selectedFenKey) ?? null;
	});

	const orientation = $derived<Color>(rep?.color ?? 'white');

	// Filtered + percentage-decorated squares for the currently selected
	// position. Already pre-sorted by count desc so the legend reads
	// strongest-first.
	const filteredSquares = $derived.by<Array<SavedAttackSquare & { pct: number }>>(() => {
		const guide = selected?.guide;
		if (!guide || !guide.attackSquares || !guide.totalLines) return [];
		const total = guide.totalLines;
		const threshold = minPctPercent / 100;
		return guide.attackSquares
			.filter((a) => {
				if (filter === 'white' && a.attacker !== 'white') return false;
				if (filter === 'black' && a.attacker !== 'black') return false;
				return a.count / total >= threshold;
			})
			.map((a) => ({ ...a, pct: a.count / total }));
	});

	// Render each surviving square as a chessground circle. Intensity is
	// conveyed via a 3-tier brush map (pale → bold → captureCount-heavy);
	// chessground doesn't fill squares natively and adding a custom SVG
	// layer for the sake of true heatmap shading would dwarf the rest of
	// this page. The legend table beneath the board carries the precise
	// percentages.
	const boardShapes = $derived.by<DrawShape[]>(() => {
		return filteredSquares.map((sq) => {
			const brush = brushFor(sq.attacker, sq.pct, sq.captureCount, sq.count);
			return { orig: sq.square as Key, brush };
		});
	});

	const currentFen = $derived.by(() => {
		if (!selected) return null;
		// EPD → FEN: append default halfmove + fullmove counters. The board
		// is view-only so the clocks are immaterial; they just need to
		// satisfy `parseFen`.
		return `${selected.guide.fenKey} 0 1`;
	});

	const sideToMove = $derived.by<Color>(() => {
		if (!selected) return 'white';
		return colorToMove(selected.guide.fenKey);
	});

	function brushFor(attacker: Color, pct: number, captureCount: number, count: number): string {
		// captureCount majority → outpost being repeatedly fought over; bump
		// to the heavier brush of the attacker's palette so it visually
		// reads as a hotspot independent of frequency.
		const captureHeavy = count > 0 && captureCount / count >= 0.5;
		const heavy = captureHeavy || pct >= 0.45;
		if (attacker === 'white') return heavy ? 'blue' : 'paleBlue';
		return heavy ? 'red' : 'paleRed';
	}

	onMount(async () => {
		const id = page.params.id;
		if (!id) {
			loading = false;
			return;
		}
		rep = (await getRepertoire(id)) ?? null;
		if (!rep) {
			loading = false;
			return;
		}
		const [guides, nodes] = await Promise.all([listMiddlegameGuides(rep.id), nodesMap(rep.id)]);
		const usable = guides.filter((g) => g.attackSquares && g.totalLines);
		const built: GuideRow[] = usable.map((guide) => {
			const path = pathToFenKey(nodes, rep!.rootFenKey, guide.fenKey);
			const lineSans = path ? path.map((e) => e.san) : [];
			return { guide, lineSans };
		});
		built.sort((a, b) => a.lineSans.length - b.lineSans.length);
		rows = built;
		// Auto-select the first row so the page lands with the board
		// populated instead of an empty right pane.
		if (built.length > 0) selectedFenKey = built[0].guide.fenKey;
		loading = false;
	});

	function moveNumberPrefix(i: number): string | null {
		return i % 2 === 0 ? `${Math.floor(i / 2) + 1}.` : null;
	}

	function formatLine(sans: string[]): string {
		if (sans.length === 0) return 'Root position';
		const parts: string[] = [];
		for (let i = 0; i < sans.length; i++) {
			const prefix = moveNumberPrefix(i);
			if (prefix) parts.push(prefix);
			parts.push(sans[i]);
		}
		return parts.join(' ');
	}
</script>

<svelte:head>
	<title>Heatmap — {rep?.name ?? 'Repertoire'}</title>
</svelte:head>

<div class="mx-auto max-w-6xl px-6 pt-12 pb-16">
	{#if loading}
		<p class="text-[var(--color-parchment-400)]">Loading…</p>
	{:else if !rep}
		<p class="text-[var(--color-oxblood-300)]">Not found.</p>
	{:else}
		<a
			href={resolve(`/repertoire/${rep.id}`)}
			class="eyebrow mb-5 inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]"
		>
			<ArrowLeft class="size-3" />
			<span class="max-w-[240px] truncate">{rep.name}</span>
		</a>

		<div class="eyebrow mb-3">Heatmap</div>
		<h1 class="font-serif text-5xl leading-[1.05] tracking-tight">
			Where pieces <em class="text-[var(--color-brass-300)]">land</em>.
		</h1>
		<p class="mt-3 max-w-xl text-[var(--color-parchment-400)]">
			For every position with a pinned middle-game guide, the full per-square attack distribution
			from the master-game aggregate — pieces and pawns landing on each square within the next ~12
			plies. Pale circles are common; bold circles are very common or capture-heavy outposts.
		</p>

		{#if rows.length === 0}
			<div
				class="ink-panel mt-10 flex flex-col items-start gap-3 p-6 text-[var(--color-parchment-400)]"
			>
				<Flame class="size-5 text-[var(--color-brass-300)]" />
				<p class="max-w-prose">
					No saved middle-game guides yet in this repertoire — or the ones you've saved were pinned
					before the heatmap data was tracked. Open the editor, navigate to a position, click <em
						class="text-[var(--color-parchment-200)]">Middle-game guide</em
					>
					to generate, then <em class="text-[var(--color-parchment-200)]">Save guide</em> to pin the heatmap
					data alongside the arrows.
				</p>
				<Button href={resolve(`/repertoire/${rep.id}/edit`)} variant="secondary" size="sm">
					Open editor
				</Button>
			</div>
		{:else}
			<div class="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
				<!-- Board + heatmap. -->
				<div>
					{#if currentFen}
						<div class="aspect-square w-full max-w-[560px]">
							<Board
								fen={currentFen}
								{orientation}
								turnColor={sideToMove}
								shapes={boardShapes}
								viewOnly
								coordinates
							/>
						</div>
					{/if}

					<!-- Filter controls under the board. -->
					<div class="mt-5 flex flex-wrap items-center gap-3">
						<div class="eyebrow text-[10px]">Attacker</div>
						{#each ['both', 'white', 'black'] as opt (opt)}
							<button
								type="button"
								class="rounded-sm border px-2.5 py-1 font-mono text-xs tracking-wider uppercase {filter ===
								opt
									? 'border-[var(--color-brass-300)] bg-[var(--color-brass-300)]/12 text-[var(--color-parchment-100)]'
									: 'border-[var(--color-ink-600)] text-[var(--color-parchment-400)] hover:text-[var(--color-parchment-100)]'}"
								onclick={() => (filter = opt as AttackerFilter)}
							>
								{opt}
							</button>
						{/each}

						<div class="ml-auto flex items-center gap-2">
							<label
								for="heatmap-threshold"
								class="font-mono text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
							>
								Min %
							</label>
							<input
								id="heatmap-threshold"
								type="range"
								min="5"
								max="60"
								step="5"
								bind:value={minPctPercent}
							/>
							<span
								class="w-8 text-right font-mono text-xs text-[var(--color-parchment-200)] tabular-nums"
							>
								{minPctPercent}%
							</span>
						</div>
					</div>

					<!-- Per-square legend. Sorted by count desc, matching the board paint order. -->
					{#if selected}
						<div class="ink-panel mt-6 overflow-hidden">
							<div
								class="border-b border-[var(--color-ink-600)] bg-[var(--color-ink-850)]/40 px-3 py-2"
							>
								<div class="eyebrow text-[10px]">
									Top squares · {filteredSquares.length} of {selected.guide.attackSquares?.length ??
										0}
									· {selected.guide.totalLines ?? 0} master games
								</div>
							</div>
							{#if filteredSquares.length === 0}
								<div class="px-3 py-4 text-sm text-[var(--color-parchment-500)]">
									Nothing crosses the {minPctPercent}% threshold. Try lowering the cutoff.
								</div>
							{:else}
								<table class="w-full text-sm">
									<thead>
										<tr
											class="border-b border-[var(--color-ink-600)] text-left font-mono text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
										>
											<th class="px-3 py-2">Square</th>
											<th class="px-3 py-2">Attacker</th>
											<th class="px-3 py-2 text-right">Lines</th>
											<th class="px-3 py-2 text-right">%</th>
											<th class="px-3 py-2 text-right">Capture-heavy</th>
										</tr>
									</thead>
									<tbody>
										{#each filteredSquares as sq (sq.square + sq.attacker)}
											{@const capPct =
												sq.count > 0 ? Math.round((sq.captureCount / sq.count) * 100) : 0}
											<tr class="border-b border-[var(--color-ink-700)]/60 last:border-b-0">
												<td
													class="px-3 py-2 font-mono text-[var(--color-parchment-100)] tabular-nums"
												>
													{sq.square}
												</td>
												<td class="px-3 py-2 text-[var(--color-parchment-300)] capitalize">
													{sq.attacker}
												</td>
												<td
													class="px-3 py-2 text-right font-mono text-[var(--color-parchment-200)] tabular-nums"
												>
													{sq.count}/{selected.guide.totalLines}
												</td>
												<td
													class="px-3 py-2 text-right font-mono text-[var(--color-parchment-100)] tabular-nums"
												>
													{Math.round(sq.pct * 100)}%
												</td>
												<td
													class="px-3 py-2 text-right font-mono tabular-nums {capPct >= 50
														? 'text-[var(--color-oxblood-300)]'
														: 'text-[var(--color-parchment-400)]'}"
												>
													{capPct}%
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							{/if}
						</div>
					{/if}
				</div>

				<!-- Position picker. -->
				<div class="lg:max-h-[calc(100vh-200px)] lg:overflow-y-auto">
					<div class="eyebrow mb-2 text-[10px]">Positions ({rows.length})</div>
					<ul class="flex flex-col gap-1">
						{#each rows as row (row.guide.fenKey)}
							{@const isSelected = row.guide.fenKey === selectedFenKey}
							<li>
								<button
									type="button"
									class="w-full rounded-sm border px-3 py-2 text-left transition-colors {isSelected
										? 'border-[var(--color-brass-300)] bg-[var(--color-brass-300)]/8'
										: 'border-[var(--color-ink-600)] hover:border-[var(--color-brass-300)]/60'}"
									onclick={() => (selectedFenKey = row.guide.fenKey)}
								>
									<div
										class="font-mono text-xs leading-snug text-[var(--color-parchment-100)] tabular-nums"
									>
										{formatLine(row.lineSans)}
									</div>
									<div
										class="mt-1 font-mono text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
									>
										{row.guide.totalLines ?? 0} games · {row.guide.attackSquares?.length ?? 0}
										squares
									</div>
								</button>
							</li>
						{/each}
					</ul>
				</div>
			</div>
		{/if}
	{/if}
</div>

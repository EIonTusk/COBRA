<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { onMount, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		ArrowLeft,
		ChevronFirst,
		ChevronLast,
		ChevronLeft,
		ChevronRight,
		FlipVertical2,
		Lightbulb,
		Pause,
		Play,
		Shuffle
	} from 'lucide-svelte';
	import type { Key } from '@lichess-org/chessground/types';
	import type { DrawShape } from '@lichess-org/chessground/draw';

	import Board from '$lib/chess/Board.svelte';
	import { getRepertoire } from '$lib/storage/repertoires';
	import { nodesMap } from '$lib/storage/nodes';
	import { getIdeaCard } from '$lib/storage/ideaCards';
	import { fenAfterMove } from '$lib/chess/position';
	import { colorToMove } from '$lib/chess/fen';
	import { Button, Select } from '$lib/ui';
	import type { Color, Edge, IdeaCard, Repertoire, RepertoireNode } from '$lib/types';

	interface Step {
		fen: string;
		fenKey: string;
		san: string;
		lastMove: [Key, Key];
	}

	let rep = $state<Repertoire | null>(null);
	let nodes = $state<Map<string, RepertoireNode>>(new Map());
	let loading = $state(true);

	let history = $state<Step[]>([]);
	let selectedChildIdx = $state(0);
	let orientation = $state<Color>('white');
	let revealIdea = $state(false);
	let ideaCard = $state<IdeaCard | null>(null);

	let autoplay = $state(false);
	let autoplaySpeed = $state<'slow' | 'normal' | 'fast'>('normal');
	let autoplayTimer: ReturnType<typeof setTimeout> | null = null;
	// DFS tour state. Edge keys (`from>to`) get marked as the walker plays
	// them; when every child of the current position is marked we
	// backtrack. Kept off of $state on purpose — mutation inside the
	// autoplay effect shouldn't trigger re-runs, the position change does.
	let tourVisited = new SvelteSet<string>();
	function edgeKey(fromKey: string, edge: Edge): string {
		return `${fromKey}>${edge.toFenKey}`;
	}

	const rootKey = $derived(rep?.rootFenKey ?? '');
	const rootFen = $derived(rep?.rootFen ?? '');

	const currentFen = $derived(history.at(-1)?.fen ?? rootFen);
	const currentFenKey = $derived(history.at(-1)?.fenKey ?? rootKey);
	const currentNode = $derived<RepertoireNode | undefined>(nodes.get(currentFenKey));
	const currentLastMove = $derived<[Key, Key] | undefined>(history.at(-1)?.lastMove);
	const currentChildren = $derived<Edge[]>(currentNode?.children ?? []);
	const sideToMove = $derived<Color>(currentFenKey ? colorToMove(currentFenKey) : 'white');
	const atLeaf = $derived(currentChildren.length === 0);

	const rootParts = $derived(rootFen.split(' '));
	const rootFullMove = $derived(parseInt(rootParts[5] ?? '1', 10) || 1);
	const rootStartsOnWhite = $derived((rootParts[1] ?? 'w') === 'w');

	// Numbered line spine: "1.e4 e5 2.Nf3 Nc6 …" built from history.
	interface SpineToken {
		text: string;
		stepIdx: number;
	}
	const spine = $derived.by<SpineToken[]>(() => {
		const out: SpineToken[] = [];
		let whiteToMove = rootStartsOnWhite;
		let moveNo = rootFullMove;
		for (let i = 0; i < history.length; i++) {
			const san = history[i].san;
			if (whiteToMove) out.push({ text: `${moveNo}.${san}`, stepIdx: i });
			else out.push({ text: san, stepIdx: i });
			if (!whiteToMove) moveNo += 1;
			whiteToMove = !whiteToMove;
		}
		return out;
	});

	// Shapes drawn on the board. The selected child gets a thick green
	// arrow (primary candidate), every other child gets a thin
	// pale-green arrow so the fan of all recorded replies is visible at
	// a glance. The board itself stays view-only — clicks go through
	// the sidebar or keyboard, not the piece set.
	const boardShapes = $derived.by<DrawShape[]>(() => {
		const shapes: DrawShape[] = [];
		if (currentChildren.length === 0) return shapes;
		const safeIdx = Math.min(selectedChildIdx, currentChildren.length - 1);
		currentChildren.forEach((edge, i) => {
			if (edge.uci.length < 4) return;
			const orig = edge.uci.slice(0, 2) as Key;
			const dest = edge.uci.slice(2, 4) as Key;
			const isPrimary = i === safeIdx;
			shapes.push({
				orig,
				dest,
				brush: isPrimary ? 'green' : 'paleGreen',
				modifiers: { lineWidth: isPrimary ? 14 : 7 }
			});
		});
		return shapes;
	});

	// NAG glyphs on the current node — rendered as a typographic badge
	// above the board.
	const NAG_GLYPHS: Record<number, { label: string; tone: string }> = {
		1: { label: '!', tone: 'text-[var(--color-olive-300)]' },
		2: { label: '?', tone: 'text-[var(--color-oxblood-300)]' },
		3: { label: '!!', tone: 'text-[var(--color-olive-300)]' },
		4: { label: '??', tone: 'text-[var(--color-oxblood-300)]' },
		5: { label: '!?', tone: 'text-[var(--color-brass-300)]' },
		6: { label: '?!', tone: 'text-[var(--color-copper-300)]' },
		10: { label: '=', tone: 'text-[var(--color-parchment-300)]' },
		13: { label: '∞', tone: 'text-[var(--color-parchment-300)]' },
		14: { label: '⩲', tone: 'text-[var(--color-parchment-200)]' },
		15: { label: '⩱', tone: 'text-[var(--color-parchment-200)]' },
		16: { label: '±', tone: 'text-[var(--color-olive-300)]' },
		17: { label: '∓', tone: 'text-[var(--color-oxblood-300)]' },
		18: { label: '+−', tone: 'text-[var(--color-olive-300)]' },
		19: { label: '−+', tone: 'text-[var(--color-oxblood-300)]' }
	};
	const currentNags = $derived(
		(currentNode?.nags ?? []).map((n) => NAG_GLYPHS[n]).filter((x) => x !== undefined)
	);

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
		nodes = await nodesMap(rep.id);
		orientation = rep.color;
		loading = false;
	});

	// Load the idea card whenever we land on a new position. Kept hidden
	// until the user reveals it so a drive-through tour isn't spoilered.
	$effect(() => {
		const key = currentFenKey;
		const repId = rep?.id;
		if (!key || !repId) return;
		revealIdea = false;
		ideaCard = null;
		void (async () => {
			const card = await getIdeaCard(repId, key);
			if (currentFenKey === key) ideaCard = card ?? null;
		})();
	});

	// Reset the sibling picker every time the position changes so the
	// next Right-arrow advances along the main branch by default.
	$effect(() => {
		const _key = currentFenKey;
		untrack(() => {
			selectedChildIdx = 0;
		});
	});

	function goForward(childIdx?: number) {
		const children = untrack(() => currentChildren);
		if (children.length === 0) {
			stopAutoplay();
			return;
		}
		const idx = childIdx ?? Math.min(selectedChildIdx, children.length - 1);
		const edge = children[idx];
		if (!edge) return;
		const fromFen = untrack(() => currentFen);
		const newFen = fenAfterMove(fromFen, edge);
		history = [
			...history,
			{
				fen: newFen,
				fenKey: edge.toFenKey,
				san: edge.san,
				lastMove: [edge.uci.slice(0, 2) as Key, edge.uci.slice(2, 4) as Key]
			}
		];
	}

	function goBack() {
		if (history.length === 0) return;
		history = history.slice(0, -1);
	}

	function goRoot() {
		history = [];
	}

	function goToStep(stepIdx: number) {
		if (stepIdx < 0) {
			history = [];
		} else if (stepIdx < history.length) {
			history = history.slice(0, stepIdx + 1);
		}
	}

	function goLeaf() {
		let fen = untrack(() => currentFen);
		let node = untrack(() => currentNode);
		const newSteps: Step[] = [];
		let guard = 0;
		while (node && node.children.length > 0 && guard++ < 256) {
			const edge = node.children[0];
			const next = fenAfterMove(fen, edge);
			newSteps.push({
				fen: next,
				fenKey: edge.toFenKey,
				san: edge.san,
				lastMove: [edge.uci.slice(0, 2) as Key, edge.uci.slice(2, 4) as Key]
			});
			fen = next;
			node = nodes.get(edge.toFenKey);
		}
		if (newSteps.length > 0) history = [...history, ...newSteps];
	}

	function pickRandomLeaf() {
		let fen = rootFen;
		let key = rootKey;
		let node = nodes.get(key);
		const newSteps: Step[] = [];
		let guard = 0;
		while (node && node.children.length > 0 && guard++ < 256) {
			const edge = node.children[Math.floor(Math.random() * node.children.length)];
			const next = fenAfterMove(fen, edge);
			newSteps.push({
				fen: next,
				fenKey: edge.toFenKey,
				san: edge.san,
				lastMove: [edge.uci.slice(0, 2) as Key, edge.uci.slice(2, 4) as Key]
			});
			fen = next;
			key = edge.toFenKey;
			node = nodes.get(key);
		}
		history = newSteps;
	}

	function selectSibling(delta: number) {
		if (currentChildren.length <= 1) return;
		const n = currentChildren.length;
		selectedChildIdx = (selectedChildIdx + delta + n) % n;
	}

	function flipOrientation() {
		orientation = orientation === 'white' ? 'black' : 'white';
	}

	function stopAutoplay() {
		autoplay = false;
		if (autoplayTimer) {
			clearTimeout(autoplayTimer);
			autoplayTimer = null;
		}
	}

	function toggleAutoplay() {
		if (autoplay) {
			stopAutoplay();
		} else {
			// "Play tour" = walk every line from the start, depth-first.
			// Reset both the walker's visited edges and the history so the
			// user always gets a fresh, exhaustive pass when they hit Play.
			tourVisited = new SvelteSet();
			history = [];
			autoplay = true;
		}
	}

	const AUTOPLAY_DELAY_MS: Record<'slow' | 'normal' | 'fast', number> = {
		slow: 2200,
		normal: 1300,
		fast: 700
	};
	// Backtracks are boring to watch at full speed; snap through them.
	const BACKTRACK_DELAY_MS = 250;

	/**
	 * Walk up the current line and return the history length we should
	 * pop to (i.e. `history.slice(0, N)`) in order to reach the nearest
	 * ancestor that still has an unvisited child edge under the tour's
	 * rules (all options on the opponent's turn, main line only on
	 * ours). Returns -1 if nothing anywhere up to the root has
	 * unexplored branches left.
	 */
	function findNextBranchAncestor(): number {
		for (let i = history.length - 1; i >= 0; i--) {
			const ancestorKey = i === 0 ? rootKey : history[i - 1].fenKey;
			const node = nodes.get(ancestorKey);
			if (!node || node.children.length === 0) continue;
			const ancestorOurMove = rep ? colorToMove(ancestorKey) === rep.color : false;
			let hasUnvisited = false;
			if (ancestorOurMove) {
				if (!tourVisited.has(edgeKey(ancestorKey, node.children[0]))) hasUnvisited = true;
			} else {
				for (const c of node.children) {
					if (!tourVisited.has(edgeKey(ancestorKey, c))) {
						hasUnvisited = true;
						break;
					}
				}
			}
			if (hasUnvisited) return i;
		}
		return -1;
	}

	// Autoplay driver: walks the tree with a bias toward breadth on the
	// opponent's side and depth on ours. Concretely:
	//   - at one of our positions: take only the main (first) child;
	//     after it's been toured, treat this node as done and backtrack.
	//     We're not trying to sightsee our own alternatives.
	//   - at an opponent position: try every recorded reply in order.
	//     This is what makes the tour useful — you see how the whole
	//     repertoire reacts to each thing the opponent can do.
	//   - if neither rule yields a new edge → pop history.
	//   - if history is empty too → the tour is done.
	// Tick duration doubles on commented positions so the reader has
	// time to actually read the comment. Backtracks use a shorter tick
	// so tree-walk retracement doesn't drag.
	$effect(() => {
		const isOn = autoplay;
		const fromKey = currentFenKey;
		const _speed = autoplaySpeed;
		if (!isOn) return;
		const node = nodes.get(fromKey);
		const ourMove = rep ? colorToMove(fromKey) === rep.color : false;
		let nextChildIdx = -1;
		if (node && node.children.length > 0) {
			if (ourMove) {
				// Only the main line on our side.
				if (!tourVisited.has(edgeKey(fromKey, node.children[0]))) {
					nextChildIdx = 0;
				}
			} else {
				for (let i = 0; i < node.children.length; i++) {
					if (!tourVisited.has(edgeKey(fromKey, node.children[i]))) {
						nextChildIdx = i;
						break;
					}
				}
			}
		}
		if (nextChildIdx >= 0) {
			const baseDelay = AUTOPLAY_DELAY_MS[autoplaySpeed];
			const hasComment = !!node?.comment && node.comment.trim().length > 0;
			const delay = hasComment ? baseDelay * 2 : baseDelay;
			autoplayTimer = setTimeout(() => {
				if (!autoplay) return;
				const edge = node!.children[nextChildIdx];
				tourVisited.add(edgeKey(fromKey, edge));
				goForward(nextChildIdx);
			}, delay);
		} else if (history.length > 0) {
			// Decide how far back the next unvisited branch is. If it's
			// deep (> 3 plies), snap to it with a fade instead of
			// popping move-by-move — the user doesn't want to watch a
			// long rewind animation.
			const target = findNextBranchAncestor();
			if (target < 0) {
				// Nothing left to explore anywhere up the spine.
				autoplay = false;
				return;
			}
			const stepsBack = history.length - target;
			if (stepsBack > 3) {
				// Long jump: apply the slice in one shot and let
				// chessground animate every piece simultaneously to its
				// ancestor square. Small pre-delay so the leaf reads as
				// an end before the board rearranges.
				autoplayTimer = setTimeout(() => {
					if (!autoplay) return;
					history = history.slice(0, target);
				}, 450);
			} else {
				autoplayTimer = setTimeout(() => {
					if (!autoplay) return;
					goBack();
				}, BACKTRACK_DELAY_MS);
			}
		} else {
			// Back at root with no unvisited children — tour complete.
			autoplay = false;
			return;
		}
		return () => {
			if (autoplayTimer) {
				clearTimeout(autoplayTimer);
				autoplayTimer = null;
			}
		};
	});

	function handleKey(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		switch (e.key) {
			case 'ArrowRight':
			case ' ':
				e.preventDefault();
				stopAutoplay();
				goForward();
				break;
			case 'ArrowLeft':
				e.preventDefault();
				stopAutoplay();
				goBack();
				break;
			case 'ArrowUp':
				e.preventDefault();
				selectSibling(-1);
				break;
			case 'ArrowDown':
				e.preventDefault();
				selectSibling(1);
				break;
			case 'Home':
				e.preventDefault();
				stopAutoplay();
				goRoot();
				break;
			case 'End':
				e.preventDefault();
				stopAutoplay();
				goLeaf();
				break;
			case 'a':
			case 'A':
				e.preventDefault();
				toggleAutoplay();
				break;
			case 'f':
			case 'F':
				e.preventDefault();
				flipOrientation();
				break;
			case 'i':
			case 'I':
				e.preventDefault();
				if (ideaCard) revealIdea = !revealIdea;
				break;
			case 'r':
			case 'R':
				e.preventDefault();
				stopAutoplay();
				pickRandomLeaf();
				break;
		}
	}

	const speedOptions = [
		{ value: 'slow', label: 'Slow · 2.2s' },
		{ value: 'normal', label: 'Normal · 1.3s' },
		{ value: 'fast', label: 'Fast · 0.7s' }
	];
</script>

<svelte:window on:keydown={handleKey} />

<div class="mx-auto max-w-[1200px] px-4 py-6 md:px-6">
	{#if loading}
		<p class="text-sm text-[var(--color-parchment-400)]">Loading…</p>
	{:else if !rep}
		<p class="text-[var(--color-oxblood-300)]">Repertoire not found.</p>
	{:else}
		<div class="mb-5 flex items-center gap-3">
			<a
				href={resolve(`/repertoire/${rep.id}`)}
				class="eyebrow inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]"
			>
				<ArrowLeft class="size-3" />
				<span class="max-w-[220px] truncate">{rep.name}</span>
			</a>
			<span class="text-[var(--color-ink-600)]">/</span>
			<span class="eyebrow text-[var(--color-parchment-300)]">Tour</span>
			<span class="ml-auto font-mono text-[11px] text-[var(--color-parchment-500)] tabular-nums">
				ply {history.length}
				{#if currentChildren.length > 1}
					· {currentChildren.length} branches
				{:else if atLeaf}
					· end of line
				{/if}
			</span>
		</div>

		<div class="grid gap-6 md:grid-cols-[minmax(0,1fr)_360px]">
			<!-- Board column -->
			<div class="mx-auto w-full max-w-[600px]">
				<!-- Depth pips: one tick per ply in the current line. Lights
					 up as you go deeper; helps the reader feel how far in
					 they are without reading the move spine. -->
				{#if history.length > 0}
					<div class="mb-3 flex items-center gap-[3px]">
						{#each Array(history.length) as _, i (i)}
							<span
								class="h-[3px] flex-1 rounded-full"
								class:bg-[var(--color-brass-300)]={i === history.length - 1}
								class:bg-[var(--color-brass-500)]={i < history.length - 1}
								class:opacity-60={i < history.length - 1}
							></span>
						{/each}
					</div>
				{/if}

				<div class="relative">
					<Board
						fen={currentFen}
						{orientation}
						turnColor={sideToMove}
						lastMove={currentLastMove}
						shapes={boardShapes}
						viewOnly
						coordinates
					/>

					<!-- NAG glyphs float in the top-right corner of the board,
						 typographic and sized large so they read as a
						 verdict on the move you just arrived at. -->
					{#if currentNags.length > 0}
						<div
							class="pointer-events-none absolute top-2 right-2 flex items-baseline gap-2 rounded-[3px] bg-[var(--color-ink-950)]/70 px-2 py-0.5 font-serif text-2xl leading-none tracking-tight backdrop-blur-sm"
						>
							{#each currentNags as nag, i (i)}
								<span class={nag.tone}>{nag.label}</span>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Transport bar directly under the board: primary
					 left/right controls, autoplay, flip. -->
				<div class="mt-4 flex flex-wrap items-center justify-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						onclick={() => {
							stopAutoplay();
							goRoot();
						}}
						disabled={history.length === 0}
						title="Home — jump to root"
					>
						<ChevronFirst class="size-4" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onclick={() => {
							stopAutoplay();
							goBack();
						}}
						disabled={history.length === 0}
						title="Left arrow — back one move"
					>
						<ChevronLeft class="size-4" />
					</Button>
					<Button
						variant={autoplay ? 'primary' : 'secondary'}
						size="sm"
						onclick={toggleAutoplay}
						title="A — play the tour (walks every opponent reply from the start)"
					>
						{#if autoplay}
							<Pause class="size-3.5" />
							<span>Pause</span>
						{:else}
							<Play class="size-3.5" />
							<span>Play tour</span>
						{/if}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onclick={() => {
							stopAutoplay();
							goForward();
						}}
						disabled={atLeaf}
						title="Right arrow — next move"
					>
						<ChevronRight class="size-4" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onclick={() => {
							stopAutoplay();
							goLeaf();
						}}
						disabled={atLeaf}
						title="End — fast-forward to leaf"
					>
						<ChevronLast class="size-4" />
					</Button>
					<span class="mx-1 h-5 w-px bg-[var(--color-ink-700)]"></span>
					<Button
						variant="ghost"
						size="sm"
						onclick={() => {
							stopAutoplay();
							pickRandomLeaf();
						}}
						title="R — jump to a random leaf"
					>
						<Shuffle class="size-3.5" />
					</Button>
					<Button variant="ghost" size="sm" onclick={flipOrientation} title="F — flip board">
						<FlipVertical2 class="size-3.5" />
					</Button>
				</div>
			</div>

			<!-- Sidebar column -->
			<aside class="space-y-5">
				<!-- Line spine. Each token is clickable — jump back to
					 that ply. The chip that matches the current position
					 is highlighted so you always know where you are. -->
				<section>
					<div class="eyebrow mb-2 flex items-center justify-between">
						<span>Line</span>
						<span class="font-mono text-[10px] tabular-nums">
							{sideToMove === rep.color ? 'your move' : 'opponent to move'}
						</span>
					</div>
					<div
						class="ink-panel flex min-h-[44px] flex-wrap gap-1 p-3 font-mono text-[13px] leading-tight"
					>
						<button
							type="button"
							class="rounded-[2px] px-1 text-[var(--color-parchment-500)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)]"
							class:bg-[var(--color-brass-500)]={history.length === 0}
							class:!text-[var(--color-ink-950)]={history.length === 0}
							onclick={() => {
								stopAutoplay();
								goRoot();
							}}>start</button
						>
						{#each spine as tok, i (tok.stepIdx)}
							<button
								type="button"
								class="rounded-[2px] px-1 transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)]"
								class:text-[var(--color-parchment-100)]={i < history.length - 1}
								class:text-[var(--color-parchment-400)]={i >= history.length - 1 &&
									i !== history.length - 1}
								class:bg-[var(--color-brass-500)]={i === history.length - 1}
								class:!text-[var(--color-ink-950)]={i === history.length - 1}
								onclick={() => {
									stopAutoplay();
									goToStep(tok.stepIdx);
								}}
							>
								{tok.text}
							</button>
						{/each}
						{#if history.length === 0 && currentChildren.length === 0}
							<span class="text-[var(--color-parchment-500)] italic">(empty repertoire)</span>
						{/if}
					</div>
				</section>

				<!-- Comment ribbon. Free-text annotations on the current
					 position, shown in italic serif for a quieter read. -->
				{#if currentNode?.comment && currentNode.comment.trim().length > 0}
					<section>
						<div class="eyebrow mb-2">Notes</div>
						<blockquote
							class="border-l-2 border-[var(--color-brass-400)]/50 pl-3 font-serif text-sm leading-relaxed text-[var(--color-parchment-200)] italic"
						>
							{currentNode.comment}
						</blockquote>
					</section>
				{/if}

				<!-- Idea card. Prompt is shown by default; the answer is
					 kept hidden behind a reveal so the user can
					 self-test mid-tour if they like. -->
				{#if ideaCard}
					<section>
						<div class="eyebrow mb-2 flex items-center gap-2">
							<Lightbulb class="size-3 text-[var(--color-brass-300)]" />
							<span>Idea</span>
						</div>
						<div class="ink-panel p-3">
							<p class="font-serif text-sm text-[var(--color-parchment-100)]">
								{ideaCard.prompt}
							</p>
							{#if ideaCard.answer}
								{#if revealIdea}
									<p
										class="mt-2 border-t border-[var(--color-ink-800)] pt-2 font-serif text-sm text-[var(--color-parchment-300)] italic"
									>
										{ideaCard.answer}
									</p>
								{:else}
									<button
										type="button"
										class="mt-2 font-mono text-[11px] tracking-wider text-[var(--color-brass-300)] uppercase hover:text-[var(--color-brass-200)]"
										onclick={() => (revealIdea = true)}
									>
										Reveal ↓
									</button>
								{/if}
							{/if}
						</div>
					</section>
				{/if}

				<!-- Branch picker: at a multi-reply position, let the
					 reader scan every alternative. The highlighted row
					 matches the green arrow on the board. Up/Down keys
					 cycle it; Enter/click jumps. -->
				{#if currentChildren.length > 0}
					<section>
						<div class="eyebrow mb-2 flex items-center justify-between">
							<span>Continuations</span>
							{#if currentChildren.length > 1}
								<span class="font-mono text-[10px] text-[var(--color-parchment-500)]">
									↑↓ to pick · → to play
								</span>
							{/if}
						</div>
						<ul
							class="divide-y divide-[var(--color-ink-800)] border-y border-[var(--color-ink-800)]"
						>
							{#each currentChildren as edge, i (edge.toFenKey)}
								{@const isSel = i === Math.min(selectedChildIdx, currentChildren.length - 1)}
								<li>
									<button
										type="button"
										class="flex w-full items-center gap-3 px-1 py-1.5 text-left font-mono text-[13px] transition-colors hover:bg-[var(--color-ink-800)]"
										onclick={() => {
											stopAutoplay();
											goForward(i);
										}}
									>
										<span
											class="inline-flex size-4 items-center justify-center rounded-full text-[9px]"
											class:bg-[var(--color-brass-300)]={isSel}
											class:text-[var(--color-ink-950)]={isSel}
											class:bg-[var(--color-ink-800)]={!isSel}
											class:text-[var(--color-parchment-400)]={!isSel}
										>
											{i + 1}
										</span>
										<span
											class:text-[var(--color-parchment-50)]={isSel}
											class:text-[var(--color-parchment-200)]={!isSel}
										>
											{edge.san}
										</span>
										{#if edge.annotation}
											<span class="truncate text-[var(--color-parchment-500)] italic">
												— {edge.annotation}
											</span>
										{/if}
									</button>
								</li>
							{/each}
						</ul>
					</section>
				{/if}

				<!-- Autoplay config + key reference. Small, out of the
					 way; useful for discoverability the first time. -->
				<section>
					<div class="eyebrow mb-2">Autoplay</div>
					<Select
						value={autoplaySpeed}
						onchange={(v) => (autoplaySpeed = v as 'slow' | 'normal' | 'fast')}
						options={speedOptions}
						class="w-full"
					/>
					<p class="mt-2 font-serif text-[11px] text-[var(--color-parchment-500)] italic">
						Walks every opponent reply from the start, showing your main-line answer to each. Pauses
						twice as long on commented positions.
					</p>
				</section>

				<section class="font-mono text-[11px] text-[var(--color-parchment-500)]">
					<div class="eyebrow mb-2 text-[var(--color-parchment-400)]">Keys</div>
					<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 tabular-nums">
						<dt>→ / space</dt>
						<dd>next move</dd>
						<dt>←</dt>
						<dd>back</dd>
						<dt>↑ ↓</dt>
						<dd>switch branch</dd>
						<dt>Home</dt>
						<dd>root</dd>
						<dt>End</dt>
						<dd>line leaf</dd>
						<dt>A</dt>
						<dd>autoplay</dd>
						<dt>F</dt>
						<dd>flip board</dd>
						<dt>R</dt>
						<dd>random line</dd>
						<dt>I</dt>
						<dd>reveal idea</dd>
					</dl>
				</section>
			</aside>
		</div>
	{/if}
</div>

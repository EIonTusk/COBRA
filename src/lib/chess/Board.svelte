<script lang="ts">
	import { untrack } from 'svelte';
	import { Chessground } from '@lichess-org/chessground';
	import type { Api } from '@lichess-org/chessground/api';
	import type { Config } from '@lichess-org/chessground/config';
	import type { DrawShape } from '@lichess-org/chessground/draw';
	import type { Key, Color as CgColor, Dests, MoveMetadata } from '@lichess-org/chessground/types';
	import { playMove, playCapture } from '$lib/ui/sounds';
	import { base } from '$app/paths';
	import { appearance } from '$lib/board/appearance.svelte';
	import { isPromotionMove } from '$lib/chess/position';

	type PromotionRole = 'q' | 'r' | 'b' | 'n';

	interface Props {
		fen: string;
		orientation?: CgColor;
		turnColor?: CgColor;
		movableColor?: CgColor | 'both';
		dests?: Dests;
		lastMove?: [Key, Key];
		check?: boolean;
		viewOnly?: boolean;
		coordinates?: boolean;
		/** Overlay shapes (arrows / circles) rendered on top of the board. */
		shapes?: DrawShape[];
		/**
		 * Fired after a legal user move. For pawn moves that reach the last
		 * rank the board first shows an in-place promotion picker (queen /
		 * knight / rook / bishop); `onmove` only fires once the user has
		 * chosen, and `promotion` carries that choice. For every other move
		 * `promotion` is undefined. Consumers must pass it straight through to
		 * `edgeFromUci` rather than assuming a queen.
		 */
		onmove?: (orig: Key, dest: Key, metadata: MoveMetadata, promotion?: PromotionRole) => void;
		/**
		 * One-shot toggle the parent can flip on (via `bind:`) to suppress the
		 * sound on the next fen change — used when the runner snaps the board
		 * to a new question position, where playing a "move" sound would
		 * sound like a phantom delayed move. Internally also flipped on after
		 * a user-initiated drag so the round-trip fen update doesn't double-
		 * sound.
		 */
		skipNextFenSound?: boolean;
	}

	let {
		fen,
		orientation = 'white',
		turnColor,
		movableColor,
		dests,
		lastMove,
		check = false,
		viewOnly = false,
		coordinates = false,
		shapes,
		onmove,
		skipNextFenSound = $bindable(false)
	}: Props = $props();

	let el: HTMLDivElement;
	let api: Api | undefined = $state();

	// While a pawn sits on the last rank awaiting a promotion choice, the
	// move is held here instead of being reported to the parent. chessground
	// has already animated the pawn onto the promotion square; picking a
	// piece reports the move (with the chosen role), cancelling snaps the
	// board back to `fen`.
	let pendingPromotion = $state<{
		orig: Key;
		dest: Key;
		metadata: MoveMetadata;
		color: CgColor;
	} | null>(null);

	// Lichess ordering, edge-inward: queen nearest the promotion rank.
	const PROMOTION_CHOICES: { role: PromotionRole; piece: string }[] = [
		{ role: 'q', piece: 'Q' },
		{ role: 'n', piece: 'N' },
		{ role: 'r', piece: 'R' },
		{ role: 'b', piece: 'B' }
	];

	// Track the fen we've already sounded for so we can detect programmatic
	// moves (opponent replies, refutation PV playback) that don't go through
	// chessground's `events.after`.
	let lastSoundedFen = '';

	function countPieces(f: string): number {
		const board = f.split(' ', 1)[0] ?? '';
		let n = 0;
		for (let i = 0; i < board.length; i++) {
			const c = board.charCodeAt(i);
			// a-z or A-Z
			if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) n++;
		}
		return n;
	}

	function buildConfig(): Config {
		return {
			fen,
			orientation,
			turnColor,
			check,
			lastMove,
			viewOnly,
			coordinates,
			movable: {
				free: false,
				color: movableColor,
				dests,
				showDests: true,
				events: {
					after: (o, d, m) => {
						// A pawn landing on the last rank: hold the move and let
						// the user pick the promotion piece. No sound and no
						// onmove until they choose (or cancel).
						if (isPromotionMove(fen, o, d)) {
							pendingPromotion = { orig: o, dest: d, metadata: m, color: turnColor ?? 'white' };
							return;
						}
						if (m.captured) playCapture();
						else playMove();
						// Parent will round-trip the resulting fen back in; don't
						// double-play when that update arrives.
						skipNextFenSound = true;
						onmove?.(o, d, m);
					}
				}
			},
			draggable: { showGhost: true },
			selectable: { enabled: true },
			highlight: { lastMove: true, check: true },
			animation: { enabled: true, duration: 150 }
		};
	}

	// Initialise chessground, and re-initialise it from scratch whenever
	// `orientation` flips. `api.set()` + `toggleOrientation()` can leave
	// drag handlers pointing at the previous side's piece set in some
	// reconfiguration sequences (symptom: switching from a white-to-move
	// card to a black-to-move card mid-session left the black pieces
	// undraggable until a full reload). A fresh Chessground instance on
	// orientation change guarantees clean handlers.
	$effect(() => {
		const _orientationDep = orientation;
		untrack(() => {
			lastSoundedFen = fen;
			skipNextFenSound = false;
		});
		api = Chessground(
			el,
			untrack(() => ({
				...buildConfig(),
				// Always instantiate with viewOnly=false so chessground binds
				// pointer/touch handlers. bindBoard skips listener attachment
				// when viewOnly is true at construction time, and a later
				// api.set({viewOnly:false}) does NOT re-bind. The handlers
				// themselves check s.viewOnly internally and no-op when true,
				// so it's safe to bind them unconditionally; the second
				// effect below immediately applies the real viewOnly value.
				viewOnly: false,
				drawable: {
					enabled: true,
					visible: true,
					autoShapes: shapes ?? [],
					// Override chessground's pale-* defaults: the upstream 0.4
					// opacity reads as washed-out on our parchment squares,
					// so the level-1 hint ring (paleGreen circle) and pale
					// arrow brushes get bumped to 0.7 for legibility. Solid
					// brushes match upstream defaults.
					brushes: {
						green: { key: 'g', color: '#15781B', opacity: 1, lineWidth: 10 },
						red: { key: 'r', color: '#882020', opacity: 1, lineWidth: 10 },
						blue: { key: 'b', color: '#003088', opacity: 1, lineWidth: 10 },
						yellow: { key: 'y', color: '#e68f00', opacity: 1, lineWidth: 10 },
						paleBlue: { key: 'pb', color: '#003088', opacity: 0.7, lineWidth: 15 },
						paleGreen: { key: 'pg', color: '#15781B', opacity: 0.7, lineWidth: 15 },
						paleRed: { key: 'pr', color: '#882020', opacity: 0.7, lineWidth: 15 },
						paleGrey: { key: 'pgr', color: '#4a4a4a', opacity: 0.35, lineWidth: 15 },
						purple: { key: 'purple', color: '#68217a', opacity: 0.65, lineWidth: 10 },
						pink: { key: 'pink', color: '#ee2080', opacity: 0.5, lineWidth: 10 },
						white: { key: 'white', color: 'white', opacity: 1, lineWidth: 10 },
						paleWhite: { key: 'pwhite', color: 'white', opacity: 0.6, lineWidth: 10 }
					}
				}
			}))
		);
		return () => {
			api?.destroy();
			api = undefined;
		};
	});

	// Config changes (fen, turnColor, lastMove, …) use api.set. This
	// effect intentionally does NOT track `orientation` because the init
	// effect above handles that via re-instantiation.
	$effect(() => {
		if (!api) return;
		api.set(buildConfig());
		if (fen !== lastSoundedFen) {
			if (skipNextFenSound) {
				skipNextFenSound = false;
			} else {
				const before = countPieces(lastSoundedFen);
				const after = countPieces(fen);
				if (after < before) playCapture();
				else playMove();
			}
			lastSoundedFen = fen;
		}
	});

	// Overlay shapes use the dedicated imperative setter so they don't get
	// reset by configure()'s autoShapes-wipe behaviour.
	$effect(() => {
		if (!api) return;
		api.setAutoShapes(shapes ?? []);
	});

	function choosePromotion(role: PromotionRole) {
		const p = pendingPromotion;
		if (!p) return;
		pendingPromotion = null;
		if (p.metadata.captured) playCapture();
		else playMove();
		// Parent round-trips the resulting fen; don't double-sound.
		skipNextFenSound = true;
		onmove?.(p.orig, p.dest, p.metadata, role);
	}

	function cancelPromotion() {
		if (!pendingPromotion) return;
		pendingPromotion = null;
		// chessground already slid the pawn onto the last rank; restore the
		// pre-move position since the parent's fen never changed.
		api?.set(buildConfig());
	}

	// Geometry for the in-place picker. Column = the destination file; the
	// four choices stack from the promotion edge toward the board centre, so
	// at the top edge they grow downward and at the bottom edge upward (the
	// choice list is reversed in that case so the queen stays edge-most).
	const promoGeometry = $derived.by(() => {
		const p = pendingPromotion;
		if (!p) return null;
		const file = p.dest.charCodeAt(0) - 97; // a=0 … h=7
		const rank = p.dest.charCodeAt(1) - 49; // '1'=0 … '8'=7
		const col = orientation === 'white' ? file : 7 - file;
		const fromTop = orientation === 'white' ? rank === 7 : rank === 0;
		const choices = fromTop ? PROMOTION_CHOICES : [...PROMOTION_CHOICES].reverse();
		const colorPrefix = p.color === 'white' ? 'w' : 'b';
		return { col, fromTop, choices, colorPrefix };
	});
</script>

<!--
	The board lives in its own element that chessground fully owns and
	re-renders; the promotion picker must NOT be a child of it or
	chessground's DOM updates clobber/cover it. It's rendered as a sibling
	inside this relative wrapper instead and positioned over the board.
-->
<div class="relative">
	<div bind:this={el} class="cg-wrap"></div>
	{#if promoGeometry}
		{@const g = promoGeometry}
		<!-- Backdrop: dims the board and cancels the promotion on tap. -->
		<button
			type="button"
			aria-label="Cancel promotion"
			class="absolute inset-0 z-10 cursor-default bg-black/45"
			onclick={cancelPromotion}
		></button>
		<!-- Picker column over the destination file. -->
		<div
			class="absolute z-20 flex flex-col"
			style:left="{g.col * 12.5}%"
			style:top={g.fromTop ? '0' : '50%'}
			style:width="12.5%"
		>
			{#each g.choices as choice (choice.role)}
				<button
					type="button"
					aria-label="Promote to {choice.role}"
					class="relative aspect-square w-full cursor-pointer bg-[var(--color-parchment-100)] shadow-[var(--shadow-md)] transition-colors hover:bg-[var(--color-brass-200)]"
					onclick={() => choosePromotion(choice.role)}
				>
					<img
						src="{base}/piece-sets/{appearance.pieces}/{g.colorPrefix}{choice.piece}.svg"
						alt=""
						class="pointer-events-none absolute inset-0 size-full"
						draggable="false"
					/>
				</button>
			{/each}
		</div>
	{/if}
</div>

<script lang="ts">
	import { untrack } from 'svelte';
	import { Chessground } from '@lichess-org/chessground';
	import type { Api } from '@lichess-org/chessground/api';
	import type { Config } from '@lichess-org/chessground/config';
	import type { DrawShape } from '@lichess-org/chessground/draw';
	import type { Key, Color as CgColor, Dests, MoveMetadata } from '@lichess-org/chessground/types';
	import { playMove, playCapture } from '$lib/ui/sounds';

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
		onmove?: (orig: Key, dest: Key, metadata: MoveMetadata) => void;
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
		onmove
	}: Props = $props();

	let el: HTMLDivElement;
	let api: Api | undefined = $state();

	// Track the fen we've already sounded for so we can detect programmatic
	// moves (opponent replies, refutation PV playback) that don't go through
	// chessground's `events.after`. `skipNextFenSound` suppresses the sound
	// for user-initiated moves, since `events.after` already played it.
	let lastSoundedFen = '';
	let skipNextFenSound = false;

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
				drawable: { enabled: true, visible: true, autoShapes: shapes ?? [] }
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
</script>

<div bind:this={el} class="cg-wrap"></div>

<script lang="ts">
	/**
	 * Settings-page picker: stacked dropdowns for board theme + piece set
	 * with a single square preview tile to their right that stretches to
	 * match the dropdowns' combined height. Selecting from a dropdown
	 * mutates the parent's settings binding AND immediately calls
	 * `appearance.set*` so the rest of the app and the preview update
	 * without waiting for save.
	 *
	 * The preview shows the chosen pieces sitting on the chosen board
	 * colours so the user reads the combination at a glance.
	 */
	import { base } from '$app/paths';
	import { Label, Select } from '$lib/ui';
	import { BOARD_THEMES, PIECE_SETS, appearance, type BoardTheme } from './appearance.svelte';

	interface Props {
		boardTheme: string;
		pieceSet: string;
		onBoardChange: (id: string) => void;
		onPieceChange: (id: string) => void;
	}

	let { boardTheme, pieceSet, onBoardChange, onPieceChange }: Props = $props();

	const boardOptions = BOARD_THEMES.map((t) => ({ value: t.id, label: t.label }));
	const pieceOptions = PIECE_SETS.map((p) => ({ value: p.id, label: p.label }));

	const selectedBoard = $derived<BoardTheme>(
		BOARD_THEMES.find((t) => t.id === boardTheme) ?? BOARD_THEMES[0]
	);

	function pickBoard(id: string) {
		onBoardChange(id);
		appearance.setBoard(id);
	}

	function pickPieces(id: string) {
		onPieceChange(id);
		appearance.setPieces(id);
	}

	// 8×8 preview board. Index = row*8+col with row 0 at the top.
	// Parity-1 dark square keeps a1 (bottom-left) dark, matching the
	// chessground convention.
	const N = 8;
	const SQUARES = Array.from({ length: N * N }, (_, i) => {
		const r = Math.floor(i / N);
		const c = i % N;
		return (r + c) % 2 === 1 ? 'dark' : 'light';
	});

	// A small but legible spread: kings, queens, knights, and a pair of
	// pawns of each colour, placed across light and dark squares so
	// silhouette + outline both read.
	type PiecePlacement = { piece: string; row: number; col: number };
	const PIECES: PiecePlacement[] = [
		// Black back-rank slice: queen on dark, king on light, knight on dark
		{ piece: 'bN', row: 0, col: 1 },
		{ piece: 'bQ', row: 0, col: 3 },
		{ piece: 'bK', row: 0, col: 4 },
		// Black pawns
		{ piece: 'bP', row: 1, col: 2 },
		{ piece: 'bP', row: 1, col: 5 },
		// White pawns
		{ piece: 'wP', row: 6, col: 2 },
		{ piece: 'wP', row: 6, col: 5 },
		// White back-rank slice
		{ piece: 'wN', row: 7, col: 6 },
		{ piece: 'wQ', row: 7, col: 3 },
		{ piece: 'wK', row: 7, col: 4 }
	];
</script>

<div class="flex items-center gap-5">
	<div class="flex min-w-0 flex-1 flex-col gap-5">
		<div>
			<Label for="board-theme">Board theme</Label>
			<Select id="board-theme" options={boardOptions} value={boardTheme} onchange={pickBoard} />
		</div>
		<div>
			<Label for="piece-set">Piece set</Label>
			<Select id="piece-set" options={pieceOptions} value={pieceSet} onchange={pickPieces} />
		</div>
	</div>

	<div
		class="relative aspect-square w-44 shrink-0 overflow-hidden rounded-[5px] border border-[var(--color-ink-700)] shadow-[var(--shadow-md)] sm:w-56"
		aria-hidden="true"
	>
		<div class="absolute inset-0 grid grid-cols-8 grid-rows-8">
			{#each SQUARES as s, i (i)}
				<div
					style:background-color={s === 'light' ? selectedBoard.light : selectedBoard.dark}
				></div>
			{/each}
		</div>
		{#each PIECES as pp, i (i)}
			<img
				src="{base}/piece-sets/{pieceSet}/{pp.piece}.svg"
				alt=""
				class="pointer-events-none absolute"
				style:top="{(pp.row / N) * 100}%"
				style:left="{(pp.col / N) * 100}%"
				style:width="{100 / N}%"
				style:height="{100 / N}%"
				loading="lazy"
				draggable="false"
			/>
		{/each}
	</div>
</div>

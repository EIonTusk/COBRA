<script lang="ts">
	/**
	 * A static, non-interactive chessboard rendered straight from a FEN — no
	 * chessground instance per board, so hundreds can live on one page cheaply.
	 * It reuses chessground's globally-imported board + cburnett piece CSS
	 * (`.cg-wrap` / `cg-board` / `piece`) so the pieces match the real board.
	 */
	interface Props {
		/** Full FEN or fenKey (EPD) — only the piece-placement field is read. */
		fen: string;
		/** Board orientation; defaults to White at the bottom. */
		orientation?: 'white' | 'black';
		/** Pixel size of the square board. */
		size?: number;
		/** Squares of the move that reached this position (e.g. `['e2','e4']`),
		 *  highlighted with chessground's last-move tint. */
		lastMove?: [string, string];
	}

	let { fen, orientation = 'white', size = 96, lastMove }: Props = $props();

	const ROLES: Record<string, string> = {
		p: 'pawn',
		n: 'knight',
		b: 'bishop',
		r: 'rook',
		q: 'queen',
		k: 'king'
	};

	interface Placed {
		role: string;
		color: 'white' | 'black';
		col: number;
		row: number;
	}

	// Parse the piece-placement field into positioned pieces. FEN lists rank 8
	// first (top) and file a first (left); for Black orientation we mirror both
	// axes so the side to move faces the viewer.
	const pieces = $derived.by<Placed[]>(() => {
		const board = fen.split(' ')[0] ?? '';
		const flip = orientation === 'black';
		const out: Placed[] = [];
		const ranks = board.split('/');
		for (let r = 0; r < ranks.length && r < 8; r++) {
			let file = 0;
			for (const ch of ranks[r]) {
				if (ch >= '1' && ch <= '8') {
					file += Number(ch);
					continue;
				}
				const role = ROLES[ch.toLowerCase()];
				if (role) {
					const col = flip ? 7 - file : file;
					const row = flip ? 7 - r : r;
					out.push({ role, color: ch <= 'Z' ? 'white' : 'black', col, row });
				}
				file += 1;
			}
		}
		return out;
	});

	// The from/to squares of the incoming move, as board coordinates. Reuses
	// chessground's `square.last-move` tint so it matches the real board.
	const highlights = $derived.by<Array<{ col: number; row: number }>>(() => {
		if (!lastMove) return [];
		const flip = orientation === 'black';
		const out: Array<{ col: number; row: number }> = [];
		for (const sq of lastMove) {
			const file = sq.charCodeAt(0) - 97;
			const rank = Number(sq[1]);
			if (file < 0 || file > 7 || !(rank >= 1 && rank <= 8)) continue;
			const rIndex = 8 - rank;
			out.push({ col: flip ? 7 - file : file, row: flip ? 7 - rIndex : rIndex });
		}
		return out;
	});
</script>

<div class="cg-wrap mini-board" style:width="{size}px" style:height="{size}px">
	<cg-board>
		{#each highlights as h (h.col + ':' + h.row)}
			<square class="last-move" style:transform="translate({h.col * 100}%, {h.row * 100}%)"
			></square>
		{/each}
		{#each pieces as p (p.col + ':' + p.row)}
			<piece class="{p.color} {p.role}" style:transform="translate({p.col * 100}%, {p.row * 100}%)"
			></piece>
		{/each}
	</cg-board>
</div>

<style>
	.mini-board {
		position: relative;
		display: block;
		border-radius: 3px;
		overflow: hidden;
	}
</style>

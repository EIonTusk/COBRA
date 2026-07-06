import type { Edge, RepertoireNode } from '$lib/types';

/**
 * A single move rendered in the variation tree. `fenKey` is the position
 * *after* the move — the jump target the sidebar hands to `jumpToFenKey`.
 */
export interface TreeMove {
	san: string;
	fenKey: string;
	/** 1-based plies from the repertoire root (used for move numbering). */
	ply: number;
	/**
	 * The drawn line is shelved: either this edge is `disabled`, or it sits
	 * below a disabled head on the path we drew it from. Purely visual — a
	 * position that also transposes into a live line is still trainable (see
	 * `liveReachableFenKeys`); here we grey the branch as drawn.
	 */
	disabled: boolean;
	/**
	 * This move's subtree was already expanded elsewhere in the tree (the
	 * position is a transposition hub). We stop at the move itself — clicking
	 * it still jumps there — but don't redraw the whole continuation twice.
	 */
	transposition: boolean;
	/**
	 * This move is a fold point the UI offers a collapse toggle on: a branching
	 * position (has sidelines) or the opening move of a top-level block (so a
	 * whole opening can be folded). Purely a UI hint — any position with
	 * children can be in the `collapsed` set.
	 */
	foldable: boolean;
	/** Currently collapsed: the continuation from this position is hidden. */
	collapsed: boolean;
	/** Number of positions hidden below this move while collapsed (0 otherwise). */
	hiddenCount: number;
}

/**
 * A contiguous run of moves drawn on one line of the outline. `depth` is the
 * indent level: 0 for a top-level block (one per distinct first move), deeper
 * for sidelines. After a variation block the mainline resumes on a fresh row
 * at the same depth, so the outline reads top-to-bottom.
 */
export interface TreeRow {
	id: string;
	depth: number;
	moves: TreeMove[];
}

export interface BuildTreeOptions {
	/** Safety cap on emitted rows for pathological trees. Default 4000. */
	maxRows?: number;
	/**
	 * Positions whose continuation is collapsed: the move that reaches one is
	 * drawn (with a hidden count) but its subtree is not, so the outline folds
	 * to that line.
	 */
	collapsed?: Set<string>;
}

/**
 * Flatten the FEN-keyed repertoire graph into an indented variation outline
 * for the editor's tree sidebar.
 *
 * Layout follows chess convention: the mainline (first child at every node)
 * flows inline; at a branching node the alternatives to the mainline move are
 * emitted as indented sidelines *right after* that move, then the mainline
 * resumes on a new row at the original depth. Each distinct first move from the
 * root starts its own top-level (depth 0) block.
 *
 * Because positions dedup by fenKey the graph can be cyclic and a subtree can
 * be reachable by several move orders. We expand each position's continuation
 * exactly once (mainline-first traversal wins the expansion); any later arrival
 * is marked `transposition` and left as a clickable leaf. That both terminates
 * on cycles and keeps a shared subtree from being drawn many times.
 */
export function buildTreeRows(
	nodes: Map<string, RepertoireNode>,
	rootFenKey: string,
	opts: BuildTreeOptions = {}
): TreeRow[] {
	const maxRows = opts.maxRows ?? 4000;
	const collapsed = opts.collapsed ?? new Set<string>();
	const rows: TreeRow[] = [];
	// Positions whose continuation has already been drawn. Seed with the root
	// so a move that transposes back to the start reads as a transposition.
	const expanded = new Set<string>([rootFenKey]);
	let idSeq = 0;
	const newRow = (depth: number): TreeRow => ({ id: `r${idSeq++}`, depth, moves: [] });

	/**
	 * Append `edge`'s move to `row`. Returns the pushed move plus the position
	 * it lands on, the inherited disabled state, and whether it's a
	 * transposition (already expanded — the caller should not descend further).
	 * Marks the position expanded the first time it's seen.
	 */
	function pushMove(row: TreeRow, edge: Edge, ply: number, parentDisabled: boolean) {
		const target = edge.toFenKey;
		const disabled = parentDisabled || !!edge.disabled;
		const transposition = expanded.has(target);
		const move: TreeMove = {
			san: edge.san,
			fenKey: target,
			ply,
			disabled,
			transposition,
			foldable: false,
			collapsed: false,
			hiddenCount: 0
		};
		row.moves.push(move);
		if (!transposition) expanded.add(target);
		return { move, target, disabled, transposition };
	}

	/**
	 * Fold a position: mark every descendant expanded (so it isn't redrawn on
	 * another line) and count how many were hidden. Cycle-safe.
	 */
	function hideSubtree(startFenKey: string): number {
		let count = 0;
		const stack = (nodes.get(startFenKey)?.children ?? []).map((e) => e.toFenKey);
		while (stack.length > 0) {
			const k = stack.pop()!;
			if (expanded.has(k)) continue;
			expanded.add(k);
			count += 1;
			for (const c of nodes.get(k)?.children ?? []) stack.push(c.toFenKey);
		}
		return count;
	}

	/**
	 * Walk one mainline starting at `entryEdge` (a child of some node), pushing
	 * rows as it goes. Variations branching off this line are recursed at
	 * `depth + 1`. `parentDisabled` inherits the shelved state; `blockStart` is
	 * true for the opening move of a top-level block (a fold point for the whole
	 * opening).
	 */
	function emitLine(
		entryEdge: Edge,
		depth: number,
		entryPly: number,
		parentDisabled: boolean,
		blockStart: boolean
	) {
		let row = newRow(depth);
		let edge: Edge | null = entryEdge;
		let ply = entryPly;
		let disabled = parentDisabled;
		let first = true;
		// Sidelines queued at the previous branch, flushed once the mainline
		// move they're alternatives to has been placed on the row.
		let pending: { subs: Edge[]; ply: number; disabled: boolean } | null = null;

		while (edge) {
			if (rows.length >= maxRows) return;
			const res = pushMove(row, edge, ply, disabled);
			disabled = res.disabled;
			const isOpeningMove = first && blockStart && depth === 0;
			first = false;

			// Flush sidelines that are alternatives to the move just placed —
			// they render indented directly beneath it.
			if (pending) {
				rows.push(row);
				for (const sub of pending.subs) {
					emitLine(sub, depth + 1, pending.ply, pending.disabled, false);
					if (rows.length >= maxRows) return;
				}
				row = newRow(depth);
				pending = null;
			}

			if (res.transposition) break;
			const kids = nodes.get(res.target)?.children ?? [];
			if (kids.length === 0) break;
			// A branching position, or a whole opening, is a fold point.
			res.move.foldable = kids.length > 1 || isOpeningMove;

			if (collapsed.has(res.target)) {
				res.move.collapsed = true;
				res.move.hiddenCount = hideSubtree(res.target);
				break;
			}

			if (kids.length > 1) {
				// Alternatives to the mainline child, flushed next iteration
				// once that child has been placed.
				pending = { subs: kids.slice(1), ply: ply + 1, disabled };
			}
			edge = kids[0];
			ply += 1;
		}

		if (row.moves.length > 0) rows.push(row);
	}

	const rootKids = nodes.get(rootFenKey)?.children ?? [];
	for (const kid of rootKids) {
		if (rows.length >= maxRows) break;
		emitLine(kid, 0, 1, false, true);
	}

	return rows;
}

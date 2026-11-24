/**
 * Tree-local helpers around "missing" moves. The explorer-backed search for
 * uncovered opponent moves (the builder's "Find gap" menu) lives in
 * `gapIndex.ts`; this module keeps the leaf counts and the shared
 * `MissingMove` shape.
 */

import { colorToMove } from '$lib/chess/fen';
import type { Color, RepertoireNode } from '$lib/types';

/**
 * Lightweight tree-local count of "user-turn leaves" — positions where it's
 * the user's turn and no reply has been recorded. Kept for callers that
 * still need the "positions you haven't answered" set; the edit-page
 * "saveable lines" stat uses `collectSaveableLeaves` instead.
 */
export function collectUserSideLeaves(
	nodes: Map<string, RepertoireNode>,
	rootFenKey: string,
	color: Color
): string[] {
	const leaves: string[] = [];
	const visited = new Set<string>([rootFenKey]);
	const queue: string[] = [rootFenKey];
	while (queue.length > 0) {
		const key = queue.shift()!;
		const node = nodes.get(key);
		if (!node) continue;
		const ourTurn = colorToMove(key) === color;
		if (ourTurn && node.children.length === 0) {
			leaves.push(key);
			continue;
		}
		for (const child of node.children) {
			if (visited.has(child.toFenKey)) continue;
			visited.add(child.toFenKey);
			queue.push(child.toFenKey);
		}
	}
	return leaves;
}

/**
 * Count complete "saveable lines" in the tree: root-to-leaf paths whose
 * terminating leaf is on the *opponent's* turn, which means the last edge
 * into that leaf was the user's move. Those are the lines the user has
 * actually prepared a response through. Lines that end on the user's own
 * turn are dropped — they're open work, not a finished line.
 *
 * The root itself is only counted if the tree is empty-ish (no children
 * from root at all); otherwise the number reflects actual terminating
 * branches.
 */
export function collectSaveableLeaves(
	nodes: Map<string, RepertoireNode>,
	rootFenKey: string,
	color: Color
): string[] {
	const leaves: string[] = [];
	const visited = new Set<string>([rootFenKey]);
	const queue: string[] = [rootFenKey];
	while (queue.length > 0) {
		const key = queue.shift()!;
		const node = nodes.get(key);
		if (!node) continue;
		if (node.children.length === 0) {
			if (colorToMove(key) !== color) leaves.push(key);
			continue;
		}
		for (const child of node.children) {
			if (visited.has(child.toFenKey)) continue;
			visited.add(child.toFenKey);
			queue.push(child.toFenKey);
		}
	}
	return leaves;
}

export interface MissingMove {
	/** Opponent-turn position the missing move originates from. */
	fromFenKey: string;
	fromFen: string;
	/** The opponent move that isn't in our tree. */
	uci: string;
	san: string;
	/** How many games played this move on Lichess. */
	games: number;
	/** Games that reached `fromFenKey`; `games / positionGames` is the move's share there. */
	positionGames?: number;
	/** FEN key after the opponent plays this move (where we'd need to reply). */
	afterFenKey: string;
	/** Depth from root (number of plies). */
	depth: number;
}

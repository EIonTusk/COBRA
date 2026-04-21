/**
 * Find "missing" moves in a repertoire: opponent-turn positions where an
 * explorer move is played in enough games to clear the repertoire's
 * "1 in N" threshold but has no edge recorded in our tree. Two entry points:
 *
 *   - `firstMissingOnLine` — walk a specific line (root → current position)
 *     and return the first uncovered opponent move encountered. Closest-to-
 *     root wins, which is what the edit-page "Next missing" button wants:
 *     address the earliest hole on the line you're sitting on.
 *
 *   - `mostPopularMissing` — BFS the whole tree and return the single most-
 *     frequently-played uncovered opponent move globally, so the "Most
 *     popular missing" jump lands on the highest-impact gap.
 *
 * Both use `rep.coverageGoal` as the threshold (games >= rootTotal / goal).
 * A probe cap keeps large trees from hammering Lichess.
 */

import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';

import { colorToMove } from '$lib/chess/fen';
import { fetchExplorer } from '$lib/explorer/client';
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
	/** FEN key after the opponent plays this move (where we'd need to reply). */
	afterFenKey: string;
	/** Depth from root (number of plies). */
	depth: number;
}

export interface MissingOpts {
	speeds?: string[];
	ratings?: number[];
	token: string;
	maxProbes?: number;
}

function applyUci(fen: string, uci: string): string | null {
	try {
		const setup = parseFen(fen).unwrap();
		const chess = Chess.fromSetup(setup).unwrap();
		const move = parseUci(uci);
		if (!move) return null;
		chess.play(move);
		return makeFen(chess.toSetup(), { epd: true });
	} catch {
		return null;
	}
}

async function probeTotal(fen: string, opts: MissingOpts): Promise<number> {
	const res = await fetchExplorer({
		fen,
		speeds: opts.speeds,
		ratings: opts.ratings,
		token: opts.token,
		moves: 30
	});
	return res.moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);
}

async function probeMissing(
	fenKey: string,
	fen: string,
	node: RepertoireNode,
	threshold: number,
	opts: MissingOpts
): Promise<MissingMove[]> {
	const res = await fetchExplorer({
		fen,
		speeds: opts.speeds,
		ratings: opts.ratings,
		token: opts.token,
		moves: 30
	});
	const covered = new Set(node.children.map((e) => e.uci));
	const out: MissingMove[] = [];
	for (const m of res.moves) {
		const games = m.white + m.draws + m.black;
		if (games < threshold) continue;
		if (covered.has(m.uci)) continue;
		const afterFen = applyUci(fen, m.uci);
		if (!afterFen) continue;
		const afterFenKey = afterFen.split(' ').slice(0, 4).join(' ');
		out.push({
			fromFenKey: fenKey,
			fromFen: fen,
			uci: m.uci,
			san: m.san,
			games,
			afterFenKey,
			depth: 0
		});
	}
	return out;
}

/**
 * Walk the given line (fenKey+fen pairs from root to the current board) and
 * return the first opponent-turn position with an uncovered threshold-popular
 * move. The move itself is the most popular uncovered one at that position.
 */
export async function firstMissingOnLine(
	nodes: Map<string, RepertoireNode>,
	path: { fenKey: string; fen: string }[],
	color: Color,
	goal: number,
	opts: MissingOpts
): Promise<MissingMove | null> {
	if (path.length === 0 || goal <= 0) return null;
	const rootTotal = await probeTotal(path[0].fen, opts);
	if (rootTotal === 0) return null;
	const threshold = rootTotal / goal;

	for (let i = 0; i < path.length; i++) {
		const { fenKey, fen } = path[i];
		if (colorToMove(fenKey) === color) continue;
		const node = nodes.get(fenKey);
		if (!node) continue;
		const missing = await probeMissing(fenKey, fen, node, threshold, opts);
		if (missing.length > 0) {
			missing.sort((a, b) => b.games - a.games);
			return { ...missing[0], depth: i };
		}
	}
	return null;
}

/**
 * BFS the tree from the root; at each opponent-turn node, probe explorer and
 * gather every uncovered threshold-popular move. Returns the full list sorted
 * by games played (desc). Callers pick top-1 or filter by `excludeFenKeys`
 * depending on the button; caching the list lets the edit page answer
 * subsequent clicks without another round of probes.
 */
export async function collectMissingMoves(
	nodes: Map<string, RepertoireNode>,
	rootFenKey: string,
	rootFen: string,
	color: Color,
	goal: number,
	fenFromKey: (k: string) => string,
	opts: MissingOpts
): Promise<MissingMove[]> {
	if (goal <= 0) return [];
	const maxProbes = opts.maxProbes ?? 40;

	const rootTotal = await probeTotal(rootFen, opts);
	if (rootTotal === 0) return [];
	const threshold = rootTotal / goal;

	const out: MissingMove[] = [];
	let probed = 1;
	const visited = new Set<string>([rootFenKey]);
	const queue: { fenKey: string; fen: string; depth: number }[] = [
		{ fenKey: rootFenKey, fen: rootFen, depth: 0 }
	];

	while (queue.length > 0) {
		if (probed > maxProbes) break;
		const { fenKey, fen, depth } = queue.shift()!;
		const node = nodes.get(fenKey);
		if (!node) continue;
		if (colorToMove(fenKey) !== color) {
			const missing = await probeMissing(fenKey, fen, node, threshold, opts);
			probed += 1;
			for (const m of missing) out.push({ ...m, depth });
		}
		for (const edge of node.children) {
			if (visited.has(edge.toFenKey)) continue;
			visited.add(edge.toFenKey);
			queue.push({ fenKey: edge.toFenKey, fen: fenFromKey(edge.toFenKey), depth: depth + 1 });
		}
	}

	out.sort((a, b) => b.games - a.games);
	return out;
}

/**
 * Convenience: return the single most-popular uncovered move globally, with
 * optional line-exclusion for the "Biggest missing" button. Thin wrapper
 * around `collectMissingMoves` + filter; kept so callers that don't want
 * to manage a cache can still get a one-shot answer.
 */
export async function mostPopularMissing(
	nodes: Map<string, RepertoireNode>,
	rootFenKey: string,
	rootFen: string,
	color: Color,
	goal: number,
	fenFromKey: (k: string) => string,
	opts: MissingOpts & { excludeFenKeys?: Set<string> }
): Promise<MissingMove | null> {
	const all = await collectMissingMoves(nodes, rootFenKey, rootFen, color, goal, fenFromKey, opts);
	const exclude = opts.excludeFenKeys;
	if (!exclude || exclude.size === 0) return all[0] ?? null;
	return all.find((m) => !exclude.has(m.fromFenKey)) ?? null;
}

/**
 * Coverage computation: for a given "1 in N games" goal, estimate what
 * fraction of the Lichess-frequent opponent continuations reachable from
 * the repertoire's root are actually answered in our tree.
 *
 *   covered  — opponent moves above the threshold that have an edge in our tree
 *   needed   — opponent moves above the threshold overall (covered + missing)
 *   ratio    — covered / needed
 *
 * The walk stops at a probe cap (default 40) so coverage runs complete even
 * on big trees without hammering Lichess. When capped, `incomplete: true`
 * signals the UI to render a "partial" indicator.
 *
 * Walk shape is deliberately threshold-independent: BFS visits every
 * position reachable through the user's prepared edges (their replies plus
 * every opponent move they've answered, regardless of how popular). Only
 * the needed/covered tally at each opponent position is filtered by the
 * "1 in N" threshold. If the walk shape were threshold-dependent, the
 * coverage % at different N values would be measured over different
 * subsets of the tree and could be non-monotonic across goals — e.g.
 * 1 in 200 lower than 1 in 300, which makes the metric uninterpretable.
 */

import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';

import { colorToMove } from '$lib/chess/fen';
import { fetchExplorer } from '$lib/explorer/client';
import type { Color, CoverageSnapshot, RepertoireNode } from '$lib/types';

export interface CoverageInputs {
	rootFen: string;
	rootFenKey: string;
	color: Color;
	goal: number;
}

export interface CoverageOpts {
	speeds?: string[];
	ratings?: number[];
	token: string;
	maxProbes?: number;
	onProgress?: (probed: number, total: number | null) => void;
}

export async function computeCoverage(
	rep: CoverageInputs,
	nodes: Map<string, RepertoireNode>,
	fenFromKey: (k: string) => string,
	opts: CoverageOpts
): Promise<CoverageSnapshot> {
	const maxProbes = opts.maxProbes ?? 40;

	// Pre-compute tree depth: if the user has zero edges built out,
	// "nothing needed" is really "nothing prepared yet" — 0% rather than
	// the trivially-satisfied 100% the formula would otherwise give.
	const totalEdges = [...nodes.values()].reduce((sum, n) => sum + n.children.length, 0);

	const rootRes = await fetchExplorer({
		fen: fenFromKey(rep.rootFenKey),
		speeds: opts.speeds,
		ratings: opts.ratings,
		token: opts.token,
		moves: 30
	});
	const rootTotal = rootRes.moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);
	if (rootTotal === 0 || rep.goal <= 0) {
		return {
			covered: 0,
			needed: 0,
			ratio: totalEdges === 0 ? 0 : 1,
			rootGames: rootTotal,
			thresholdGames: 0,
			probed: 1,
			incomplete: false,
			computedAt: Date.now(),
			goal: rep.goal,
			edgeCount: totalEdges
		};
	}
	const threshold = rootTotal / rep.goal;

	let covered = 0;
	let needed = 0;
	let probed = 1;
	let incomplete = false;
	const visited = new Set<string>([rep.rootFenKey]);
	const queue: string[] = [rep.rootFenKey];

	opts.onProgress?.(probed, null);

	while (queue.length > 0) {
		if (probed >= maxProbes) {
			incomplete = true;
			break;
		}
		const fenKey = queue.shift()!;
		const node = nodes.get(fenKey);
		if (!node) continue;
		const ourTurn = colorToMove(fenKey) === rep.color;

		if (!ourTurn) {
			// Opponent turn: probe explorer (root was probed up top; skip
			// the re-fetch there) and tally needed/covered at this position.
			let moves: typeof rootRes.moves | null = null;
			if (fenKey === rep.rootFenKey) {
				moves = rootRes.moves;
			} else {
				try {
					const res = await fetchExplorer({
						fen: fenFromKey(fenKey),
						speeds: opts.speeds,
						ratings: opts.ratings,
						token: opts.token,
						moves: 30
					});
					probed += 1;
					moves = res.moves;
					opts.onProgress?.(probed, null);
				} catch {
					// Rate limit / network failure — flag the snapshot but
					// keep walking the tree so other positions still count.
					incomplete = true;
				}
			}

			if (moves) {
				for (const m of moves) {
					const games = m.white + m.draws + m.black;
					if (games < threshold) continue;
					needed += 1;
					const childKey = applyUciToFenKey(fenKey, m.uci, fenFromKey);
					if (!childKey) continue;
					const edge = node.children.find((e) => e.toFenKey === childKey);
					if (edge) covered += 1;
				}
			}
		}

		// Walk every prepared continuation regardless of threshold or turn.
		// Keeping the walk shape independent of N is what makes coverage %
		// monotonically interpretable across goals (see header comment).
		for (const edge of node.children) {
			if (!visited.has(edge.toFenKey)) {
				visited.add(edge.toFenKey);
				queue.push(edge.toFenKey);
			}
		}
	}

	// Empty tree → nothing prepared, not "trivially complete". A walk that
	// genuinely completes with `needed === 0` (e.g. a position so narrow
	// there really are no threshold-crossing replies) keeps 100 %.
	const ratio = needed === 0 ? (totalEdges === 0 ? 0 : 1) : covered / needed;
	return {
		covered,
		needed,
		ratio,
		rootGames: rootTotal,
		thresholdGames: threshold,
		probed,
		incomplete,
		computedAt: Date.now(),
		goal: rep.goal,
		edgeCount: totalEdges
	};
}

function applyUciToFenKey(
	fenKey: string,
	uci: string,
	fenFromKey: (k: string) => string
): string | null {
	try {
		const fen = fenFromKey(fenKey);
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

export const COVERAGE_GOALS = [100, 200, 300, 500, 750, 1000, 1500] as const;

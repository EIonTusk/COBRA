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
			goal: rep.goal
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

		if (ourTurn) {
			for (const edge of node.children) {
				if (!visited.has(edge.toFenKey)) {
					visited.add(edge.toFenKey);
					queue.push(edge.toFenKey);
				}
			}
			continue;
		}

		// Opponent turn: probe explorer if we haven't already (root was probed
		// up top; skip a re-probe there).
		let moves = rootRes.moves;
		if (fenKey !== rep.rootFenKey) {
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
				// On any error (rate limit, network), count this branch as
				// not-probed and keep going.
				incomplete = true;
				continue;
			}
		}

		for (const m of moves) {
			const games = m.white + m.draws + m.black;
			if (games < threshold) continue;
			needed += 1;
			const childKey = applyUciToFenKey(fenKey, m.uci, fenFromKey);
			if (!childKey) continue;
			const edge = node.children.find((e) => e.toFenKey === childKey);
			if (edge) {
				covered += 1;
				if (!visited.has(childKey)) {
					visited.add(childKey);
					queue.push(childKey);
				}
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
		goal: rep.goal
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

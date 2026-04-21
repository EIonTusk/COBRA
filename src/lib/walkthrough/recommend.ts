/**
 * Pick "deep coverage" masters games for the walkthrough page: games that
 * followed one of the user's repertoires the longest.
 *
 * Two-phase approach:
 *   1. Probe the masters explorer's `topGames` at deep positions in each
 *      repertoire tree. This surfaces candidate games that *reached* those
 *      positions — but Lichess's explorer indexes by FEN, so a candidate may
 *      have arrived via a transposition instead of actually following the
 *      user's move order.
 *   2. Verify each candidate by fetching its PGN and walking it move-by-move
 *      against the repertoire it surfaced under, measuring the longest
 *      prefix that actually matches. Games whose real prefix depth falls
 *      below `minDepth` are discarded; the reported `depth` is the verified
 *      prefix depth, not the position-lookup depth.
 */

import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { parseSan, makeSanAndPlay } from 'chessops/san';
import { parsePgn, startingPosition } from 'chessops/pgn';

import { fetchExplorer, type TopGameEntry } from '$lib/explorer/client';
import { fetchMastersGamePgn } from '$lib/lichess/singleGame';
import type { Color, Edge, RepertoireNode } from '$lib/types';

export interface RepertoireInput {
	id: string;
	name: string;
	color: Color;
	rootFen: string;
	rootFenKey: string;
	nodes: Map<string, RepertoireNode>;
}

export interface RecommendedGame {
	game: TopGameEntry;
	depth: number;
	repertoireId: string;
	repertoireName: string;
	repertoireColor: Color;
	seenAtFen: string;
}

export interface RecommendOpts {
	reps: RepertoireInput[];
	token?: string;
	signal?: AbortSignal;
	/** Max masters probes in total across all reps. */
	maxProbes?: number;
	/** Max games returned. */
	limit?: number;
	/**
	 * Minimum ply depth at which a game counts as "followed your prep". A
	 * game that only reached the 4th ply of your tree isn't really following
	 * your preparation — it's just 1.e4 e5. Default 5 (roughly past opening
	 * fork, before mainline theory divergences).
	 */
	minDepth?: number;
}

export async function recommendDeepGames(opts: RecommendOpts): Promise<RecommendedGame[]> {
	const maxProbes = opts.maxProbes ?? 40;
	const limit = opts.limit ?? 24;
	const minDepth = opts.minDepth ?? 5;

	// Flatten every rep's tree nodes with their full FEN. We probe deepest
	// first but include many mid-depth positions too — a game that diverged
	// one or two plies before a leaf is still good prep-practice, and
	// probing only the very-deepest misses those because Lichess's
	// `topGames` endpoint only returns 15 games per position.
	const probes = collectTreeNodes(opts.reps, Math.max(maxProbes, limit * 3));

	// Aggregate by game id: keep the max observed depth so a game seen at
	// multiple positions gets credit for the deepest one.
	const best = new Map<
		string,
		{
			game: TopGameEntry;
			depth: number;
			repertoireId: string;
			repertoireName: string;
			repertoireColor: Color;
			seenAtFen: string;
		}
	>();

	let probed = 0;
	for (const p of probes) {
		if (probed >= maxProbes) break;
		if (opts.signal?.aborted) break;
		try {
			const res = await fetchExplorer({
				fen: p.fen,
				source: 'masters',
				moves: 0,
				topGames: 15,
				token: opts.token
			});
			probed += 1;
			for (const g of res.topGames ?? []) {
				const prev = best.get(g.id);
				if (!prev || p.depth > prev.depth) {
					best.set(g.id, {
						game: g,
						depth: p.depth,
						repertoireId: p.repertoireId,
						repertoireName: p.repertoireName,
						repertoireColor: p.repertoireColor,
						seenAtFen: p.fen
					});
				}
			}
		} catch {
			probed += 1;
			continue;
		}
	}

	// Verify each candidate against the rep it surfaced under by fetching
	// the game's PGN and measuring the real move-by-move prefix depth.
	// Lichess's explorer is position-indexed, so a candidate surfaced at a
	// tree node of depth N may have reached that node through a different
	// move order — from the user's point of view it deviates early.
	const candidates = [...best.values()];
	const repsById = new Map(opts.reps.map((r) => [r.id, r]));
	const verified = await verifyCandidates(candidates, repsById, {
		signal: opts.signal,
		token: opts.token,
		concurrency: 3
	});

	return verified
		.filter((v) => v.depth >= minDepth)
		.sort((a, b) => b.depth - a.depth)
		.slice(0, limit);
}

interface VerifyOpts {
	signal?: AbortSignal;
	token?: string;
	concurrency: number;
}

async function verifyCandidates(
	candidates: RecommendedGame[],
	repsById: Map<string, RepertoireInput>,
	opts: VerifyOpts
): Promise<RecommendedGame[]> {
	const out: RecommendedGame[] = [];
	let cursor = 0;
	async function worker() {
		while (cursor < candidates.length) {
			if (opts.signal?.aborted) return;
			const i = cursor++;
			const c = candidates[i];
			const rep = repsById.get(c.repertoireId);
			if (!rep) continue;
			try {
				const pgn = await fetchMastersGamePgn(c.game.id, opts.token);
				const actual = measurePrefixDepth(pgn, rep);
				if (actual > 0) {
					out.push({ ...c, depth: actual });
				}
			} catch {
				// Drop on any fetch/parse failure — we can't verify.
			}
		}
	}
	const workers = Array.from({ length: Math.max(1, opts.concurrency) }, () => worker());
	await Promise.all(workers);
	return out;
}

/**
 * Walk the PGN's mainline against the repertoire tree from its root, returning
 * the longest move-by-move matching prefix (in plies). Opponent moves count
 * toward depth when the game follows an edge we have at that position; on our
 * turn we require the game's SAN to be one of our edges at the current node.
 */
function measurePrefixDepth(pgn: string, rep: RepertoireInput): number {
	const games = parsePgn(pgn);
	if (games.length === 0) return 0;
	const game = games[0];
	const startR = startingPosition(game.headers);
	if (startR.isErr) return 0;
	const pos = startR.value;
	// Game must start from the same root as the repertoire.
	const gameRootKey = makeFen(pos.toSetup(), { epd: true });
	if (gameRootKey !== rep.rootFenKey) return 0;

	let depth = 0;
	let currentKey = rep.rootFenKey;
	for (const node of game.moves.mainline()) {
		const move = parseSan(pos, node.san);
		if (!move) break;
		const treeNode = rep.nodes.get(currentKey);
		if (!treeNode || treeNode.children.length === 0) break;
		const san = makeSanAndPlay(pos, move);
		const edge = treeNode.children.find((e) => e.san === san);
		if (!edge) break;
		depth++;
		currentKey = edge.toFenKey;
	}
	return depth;
}

/**
 * Walk each rep's tree and rank positions for probing. Ordering prefers
 * deeper positions but deliberately includes a tail of mid-depth ones so
 * games that diverged a ply or two before a leaf still surface. Lichess's
 * `topGames` endpoint only returns up to 15 games per position; probing
 * only the deepest nodes therefore caps the whole suggestion list at ~15
 * even when the user has a wide tree full of richer mid-depth branches.
 */
function collectTreeNodes(
	reps: RepertoireInput[],
	cap: number
): Array<{
	fen: string;
	depth: number;
	repertoireId: string;
	repertoireName: string;
	repertoireColor: Color;
}> {
	const perRep = reps.map((rep) => {
		const entries: Array<{ fen: string; depth: number }> = [];
		const visited = new Set<string>();
		const queue: Array<{ fen: string; fenKey: string; depth: number }> = [
			{ fen: rep.rootFen, fenKey: rep.rootFenKey, depth: 0 }
		];
		while (queue.length > 0) {
			const cur = queue.shift()!;
			if (visited.has(cur.fenKey)) continue;
			visited.add(cur.fenKey);
			entries.push({ fen: cur.fen, depth: cur.depth });
			const node = rep.nodes.get(cur.fenKey);
			if (!node) continue;
			for (const edge of node.children) {
				const nextFen = playEdge(cur.fen, edge);
				if (!nextFen) continue;
				queue.push({ fen: nextFen, fenKey: edge.toFenKey, depth: cur.depth + 1 });
			}
		}
		// Drop openings-book noise (very first few plies). Keep everything
		// below that; the caller filters on `minDepth` again post-aggregation.
		const ranked = entries.filter((e) => e.depth >= 3);
		ranked.sort((a, b) => b.depth - a.depth);
		// Take a generous slice per rep so mid-depth positions get probed
		// too. The outer interleave + `cap` keeps the total bounded.
		const perRepCap = Math.max(20, Math.ceil((cap * 2) / Math.max(reps.length, 1)));
		return { rep, entries: ranked.slice(0, perRepCap) };
	});

	// Interleave across reps so each gets probed turn-by-turn.
	const merged: Array<{
		fen: string;
		depth: number;
		repertoireId: string;
		repertoireName: string;
		repertoireColor: Color;
	}> = [];
	let idx = 0;
	while (merged.length < cap) {
		let progressed = false;
		for (const { rep, entries } of perRep) {
			const e = entries[idx];
			if (!e) continue;
			merged.push({
				fen: e.fen,
				depth: e.depth,
				repertoireId: rep.id,
				repertoireName: rep.name,
				repertoireColor: rep.color
			});
			progressed = true;
			if (merged.length >= cap) break;
		}
		if (!progressed) break;
		idx += 1;
	}
	return merged;
}

function playEdge(fromFen: string, edge: Edge): string | null {
	try {
		const setup = parseFen(fromFen).unwrap();
		const pos = Chess.fromSetup(setup).unwrap();
		const move = parseSan(pos, edge.san);
		if (!move) return null;
		makeSanAndPlay(pos, move);
		return makeFen(pos.toSetup());
	} catch {
		return null;
	}
}

/**
 * Consensus analyser. For each user move at a given position, query the
 * Lichess Opening Explorer for what other players at the same rating /
 * speed actually played there, and score the user's move's *alignment*
 * with the crowd:
 *
 *   alignment = plays(userSan) / totalPlays
 *
 * Aggregated across moves it answers "how often do you make the same
 * decision as a typical peer in your shoes?". Below a threshold (and
 * when the crowd has a clear majority pick) we surface the move as a
 * **consensus miss** — a per-position leak that's data-driven instead of
 * heuristic.
 *
 * Skip rules:
 *  - First N plies (default 16) — opening theory inflates alignment.
 *  - Positions with < minPlays peers in Explorer — too sparse to matter.
 *
 * Caching: requests go through `getExplorerStats`, which holds an
 * in-memory map and an IndexedDB cache (30-day TTL). Re-runs across
 * sessions cost almost nothing.
 */

import {
	getExplorerStats,
	ratingsForRating,
	type ExplorerMove,
	type ExplorerOpts
} from '$lib/lichess/explorer';
import type { ClassifiedGame } from './classify';

export interface ConsensusMoveResult {
	gameId: string;
	playedAt: number;
	ply: number;
	phase: 'opening' | 'middle' | 'end';
	san: string;
	fenBefore: string;
	color: 'white' | 'black';
	alignment: number;
	totalPlays: number;
	topAlternative: { san: string; share: number } | null;
}

export interface ConsensusGameSummary {
	gameId: string;
	moves: number;
	avgAlignment: number;
}

export interface ConsensusSummary {
	movesAnalysed: number;
	movesSkippedOpening: number;
	movesSkippedSparse: number;
	avgAlignment: number;
	misses: ConsensusMoveResult[];
	perGame: ConsensusGameSummary[];
}

export interface ConsensusOpts {
	token?: string;
	minPlays?: number;
	skipOpeningPly?: number;
	missAlignmentMax?: number;
	missTopShareMin?: number;
	maxMisses?: number;
	signal?: AbortSignal;
	onProgress?: (done: number, total: number) => void;
	/**
	 * Explorer dataset to compare against. `'lichess'` (default) is the
	 * peer-rating crowd; `'masters'` switches to the OTB masters DB, which
	 * tells you "how often did you pick the move strong players pick?". The
	 * masters DB ignores speed/rating filters, so those become no-ops.
	 */
	source?: 'lichess' | 'masters';
}

function inferSpeeds(games: ClassifiedGame[]): ExplorerOpts['speeds'] {
	const set = new Set<string>();
	for (const g of games) set.add(g.speed);
	const allowed = new Set([
		'ultraBullet',
		'bullet',
		'blitz',
		'rapid',
		'classical',
		'correspondence'
	]);
	return [...set].filter((s) => allowed.has(s)) as ExplorerOpts['speeds'];
}

function inferUserRating(games: ClassifiedGame[]): number | null {
	let sum = 0;
	let n = 0;
	for (const g of games) {
		if (g.userRating != null) {
			sum += g.userRating;
			n += 1;
		}
	}
	return n > 0 ? Math.round(sum / n) : null;
}

export async function analyseConsensus(
	games: ClassifiedGame[],
	opts: ConsensusOpts = {}
): Promise<ConsensusSummary> {
	// Masters-DB positions have far fewer games than the crowd at the same
	// FEN — the masters dataset has tens of games where the crowd has
	// thousands. Drop the default minPlays floor accordingly so we don't
	// skip every middlegame position when source='masters'.
	const minPlays = opts.minPlays ?? (opts.source === 'masters' ? 5 : 50);
	const skipOpeningPly = opts.skipOpeningPly ?? 16;
	const missAlignmentMax = opts.missAlignmentMax ?? 0.1;
	const missTopShareMin = opts.missTopShareMin ?? 0.4;
	const maxMisses = opts.maxMisses ?? 25;

	const speeds = inferSpeeds(games);
	const userRating = inferUserRating(games);
	const ratings = userRating != null ? ratingsForRating(userRating) : undefined;

	const work: Array<{ game: ClassifiedGame; moveIndex: number }> = [];
	for (const g of games) {
		for (let i = 0; i < g.moves.length; i++) {
			if (g.moves[i].ply >= skipOpeningPly) work.push({ game: g, moveIndex: i });
		}
	}

	const movesSkippedOpening = games.reduce(
		(s, g) => s + g.moves.filter((m) => m.ply < skipOpeningPly).length,
		0
	);

	const allResults: ConsensusMoveResult[] = [];
	let movesSkippedSparse = 0;
	let alignmentSum = 0;
	const perGameAcc = new Map<string, { sum: number; n: number; gameId: string }>();

	for (let i = 0; i < work.length; i++) {
		if (opts.signal?.aborted) break;
		const { game, moveIndex } = work[i];
		const m = game.moves[moveIndex];

		let stats;
		try {
			stats = await getExplorerStats(
				m.fenBefore,
				{ speeds, ratings, signal: opts.signal, source: opts.source },
				opts.token
			);
		} catch {
			movesSkippedSparse += 1;
			opts.onProgress?.(i + 1, work.length);
			continue;
		}

		if (stats.total < minPlays) {
			movesSkippedSparse += 1;
			opts.onProgress?.(i + 1, work.length);
			continue;
		}

		const alignment = shareOfSan(stats.moves, m.san, stats.total);
		const top = topMove(stats.moves, stats.total, m.san);
		alignmentSum += alignment;

		const acc = perGameAcc.get(game.gameId) ?? { sum: 0, n: 0, gameId: game.gameId };
		acc.sum += alignment;
		acc.n += 1;
		perGameAcc.set(game.gameId, acc);

		allResults.push({
			gameId: game.gameId,
			playedAt: game.playedAt,
			ply: m.ply,
			phase: m.phase,
			san: m.san,
			fenBefore: m.fenBefore,
			color: game.color,
			alignment,
			totalPlays: stats.total,
			topAlternative: top
		});

		opts.onProgress?.(i + 1, work.length);
	}

	const movesAnalysed = allResults.length;
	const avgAlignment = movesAnalysed > 0 ? alignmentSum / movesAnalysed : 0;

	const misses = allResults
		.filter(
			(r) =>
				r.alignment <= missAlignmentMax &&
				r.topAlternative != null &&
				r.topAlternative.share >= missTopShareMin
		)
		.sort((a, b) => (b.topAlternative?.share ?? 0) - (a.topAlternative?.share ?? 0))
		.slice(0, maxMisses);

	const perGame: ConsensusGameSummary[] = [...perGameAcc.values()]
		.map((g) => ({ gameId: g.gameId, moves: g.n, avgAlignment: g.sum / g.n }))
		.sort((a, b) => a.avgAlignment - b.avgAlignment);

	return {
		movesAnalysed,
		movesSkippedOpening,
		movesSkippedSparse,
		avgAlignment,
		misses,
		perGame
	};
}

function shareOfSan(moves: ExplorerMove[], san: string, total: number): number {
	if (total === 0) return 0;
	const m = moves.find((x) => x.san === san);
	if (!m) return 0;
	return (m.white + m.draws + m.black) / total;
}

function topMove(
	moves: ExplorerMove[],
	total: number,
	excludeSan?: string
): { san: string; share: number } | null {
	let best: { san: string; share: number } | null = null;
	for (const m of moves) {
		if (excludeSan && m.san === excludeSan) continue;
		const share = (m.white + m.draws + m.black) / total;
		if (!best || share > best.share) best = { san: m.san, share };
	}
	return best;
}

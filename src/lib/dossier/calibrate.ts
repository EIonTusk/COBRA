/**
 * Self-calibrate a style baseline from the user's own opponents.
 *
 * Why self-calibrate: shipping a single eyeballed baseline (or even an
 * empirical GM-derived one) compares a 1500-rated user to the wrong
 * population. Their actual peers are the people they sit across from,
 * and matchmaking has already done the rating-band filtering for free.
 *
 * The flow:
 *  1. Take the just-scanned games, extract opponent usernames + ratings.
 *  2. Restrict to opponents whose rating falls within ±band of the user.
 *  3. Snowball one hop: for each surviving opponent, fetch their N most
 *     recent games via the existing source streamers (Lichess token used
 *     when available; chess.com is anon).
 *  4. Classify each fetched game from that opponent's perspective and
 *     fold per-move features into a running aggregate.
 *  5. Return a baseline bucket for the (speed, ratingMin, ratingMax)
 *     triple. Caller persists to IDB and registers it at runtime.
 *
 * Costs: ~1.5s per opponent fetched (Lichess) or ~1s (chess.com archive).
 * 30 opponents × 20 games each = ~600 games × 40 user-side moves = ~24k
 * feature rows. About 45–60s on a warm connection, mostly network.
 */

import { streamUserGames } from '$lib/lichess/games';
import { streamChesscomGames } from '$lib/chesscom/games';
import { effectiveLichessToken } from '$lib/storage/settings';
import {
	bucketKey,
	type StoredBaselineBucket,
	type BaselinePhaseColor,
	type BaselineCriticalMoments,
	type BaselineClockSpend
} from '$lib/storage/baselines';
import type { AppSettings } from '$lib/types';

import { classifyGame, type ClassifiedGame, type MoveFeatures, type Phase } from './classify';
import type { DossierScanResult } from './scan';
import { analyseEvalAxes, type EvalAxesSummary, type EvalMoveResult } from './evalAxes';
import { buildCriticalMoments } from './criticalMoments';
import { buildClockSpend } from './clockSpend';

export interface CalibrateOpts {
	settings: AppSettings;
	scan: DossierScanResult;
	/** Width of the rating window around the user (default ±150). */
	ratingHalfBand?: number;
	/** Cap on opponents to walk through. */
	maxOpponents?: number;
	/** Games to fetch per opponent. */
	gamesPerOpponent?: number;
	/** Whether to include chess.com opponents (slower; archive walk). */
	includeChesscom?: boolean;
	signal?: AbortSignal;
	onProgress?: (done: number, total: number, label: string) => void;
	/**
	 * Optional v2 engine pass: run Stockfish over a capped subset of the
	 * peer games to populate `evalByPhaseColor`, `criticalMoments`, and
	 * `clockSpend` on the bucket. Expensive — gate behind a UI checkbox.
	 */
	runEval?: boolean;
	/** Cap on peer games sent through the engine. Default 30. */
	evalGameCap?: number;
	/** Engine depth for the peer pass. Default 12 (one step shallower than
	 * the user pass to keep the extra cost bounded). */
	evalDepth?: number;
	onEvalProgress?: (done: number, total: number) => void;
}

export interface CalibrateResult {
	bucket: StoredBaselineBucket;
	skipped: { reason: string; count: number }[];
}

interface OpponentSeed {
	source: 'lichess' | 'chesscom';
	username: string;
	rating: number;
}

export async function calibrateBaseline(opts: CalibrateOpts): Promise<CalibrateResult> {
	const ratingHalfBand = opts.ratingHalfBand ?? 150;
	const maxOpponents = opts.maxOpponents ?? 30;
	const gamesPerOpponent = opts.gamesPerOpponent ?? 20;

	const fp = opts.scan.fingerprint;
	if (fp.avgUserRating == null) {
		throw new Error('Scan has no rating info — calibrate after a rated scan.');
	}
	const userRating = fp.avgUserRating;
	const ratingMin = userRating - ratingHalfBand;
	const ratingMax = userRating + ratingHalfBand;

	const speed = primarySpeed(opts.scan.classified);
	if (!speed) throw new Error('Scan has no games — nothing to calibrate from.');

	const seeds = collectOpponentSeeds(opts.scan.classified, ratingMin, ratingMax, speed);
	if (seeds.length === 0) {
		throw new Error(
			`No opponents in [${ratingMin}, ${ratingMax}] @ ${speed} — widen the band or scan more games.`
		);
	}
	const sample = seeds.slice(0, maxOpponents);

	const token = effectiveLichessToken(opts.settings);
	const acc = emptyAcc();
	const peerGames: ClassifiedGame[] = [];
	let totalGamesProcessed = 0;
	const skipped = new Map<string, number>();

	for (let i = 0; i < sample.length; i++) {
		if (opts.signal?.aborted) break;
		const seed = sample[i];
		opts.onProgress?.(i, sample.length, `${seed.source}/${seed.username}`);

		if (seed.source === 'lichess' && !token) {
			bumpSkip(skipped, 'no Lichess token');
			continue;
		}
		if (seed.source === 'chesscom' && !opts.includeChesscom) {
			bumpSkip(skipped, 'chess.com excluded');
			continue;
		}

		try {
			const stream =
				seed.source === 'chesscom'
					? streamChesscomGames(seed.username, {
							max: gamesPerOpponent,
							rated: true,
							signal: opts.signal
						})
					: streamUserGames(seed.username, {
							max: gamesPerOpponent,
							token,
							variant: 'standard',
							rated: true,
							// Same adoption path as the main dossier scan: if the peer
							// has analysed games on Lichess, pull the server-side
							// `%eval` tags and skip the local engine for those moves.
							evals: opts.settings.useLichessServerEval !== false,
							signal: opts.signal
						});

			for await (const game of stream) {
				if (opts.signal?.aborted) break;
				if (game.variant && game.variant !== 'standard') continue;
				if (game.speed !== speed) continue;
				const c = classifyGame(game, seed.username);
				if (!c) continue;
				absorb(acc, c);
				peerGames.push(c);
				totalGamesProcessed += 1;
			}
		} catch (e) {
			bumpSkip(skipped, e instanceof Error ? e.message : 'fetch failed');
		}
	}
	opts.onProgress?.(sample.length, sample.length, 'done');

	if (acc.totalMoves === 0) {
		throw new Error('Snowball produced no moves — try widening the rating band.');
	}

	let evalByPhaseColor: BaselinePhaseColor | undefined;
	let criticalMoments: BaselineCriticalMoments | undefined;
	let clockSpend: BaselineClockSpend | undefined;
	let evalGamesSampled: number | undefined;
	let evalMovesAnalysed: number | undefined;

	if (opts.runEval && peerGames.length > 0 && !opts.signal?.aborted) {
		const cap = opts.evalGameCap ?? 30;
		const subset = peerGames.slice(0, cap);
		let evalSummary: EvalAxesSummary;
		try {
			evalSummary = await analyseEvalAxes(subset, {
				depth: opts.evalDepth ?? 12,
				signal: opts.signal,
				onProgress: opts.onEvalProgress,
				lichessToken: token ?? undefined
			});
		} catch (e) {
			bumpSkip(skipped, `peer engine pass failed: ${e instanceof Error ? e.message : String(e)}`);
			evalSummary = null as unknown as EvalAxesSummary;
		}

		if (evalSummary && evalSummary.movesAnalysed > 0) {
			evalByPhaseColor = toBaselinePhaseColor(evalSummary);
			criticalMoments = toBaselineCriticalMoments(evalSummary.allMoves);
			clockSpend = toBaselineClockSpend(subset, evalSummary.allMoves);
			evalGamesSampled = subset.length;
			evalMovesAnalysed = evalSummary.movesAnalysed;
		}
	}

	const bucket: StoredBaselineBucket = {
		id: bucketKey(speed, ratingMin, ratingMax),
		bucket: speed,
		ratingMin,
		ratingMax,
		games: acc.games,
		totalMoves: acc.totalMoves,
		axes: {
			forcing: round(acc.forcing / acc.totalMoves),
			capture: round(acc.capture / acc.totalMoves),
			pawnPlay: round(acc.pawnPlay / acc.totalMoves),
			queenside: round(acc.queenside / acc.totalMoves),
			earlyCastle: round(acc.castledGames / Math.max(1, acc.games))
		},
		tension: {
			releaseRate: acc.tensioned > 0 ? round(acc.released / acc.tensioned) : 0,
			creationRate: round(acc.created / acc.totalMoves)
		},
		computedAt: Date.now(),
		source: 'self-calibrated',
		seedCount: sample.length,
		sampledUsers: sample.length,
		evalByPhaseColor,
		criticalMoments,
		clockSpend,
		evalGamesSampled,
		evalMovesAnalysed
	};

	void totalGamesProcessed;
	return {
		bucket,
		skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count }))
	};
}

function toBaselinePhaseColor(summary: EvalAxesSummary): BaselinePhaseColor {
	return {
		opening: {
			white: roundPhase(summary.byPhaseColor.opening.white),
			black: roundPhase(summary.byPhaseColor.opening.black)
		},
		middle: {
			white: roundPhase(summary.byPhaseColor.middle.white),
			black: roundPhase(summary.byPhaseColor.middle.black)
		},
		end: {
			white: roundPhase(summary.byPhaseColor.end.white),
			black: roundPhase(summary.byPhaseColor.end.black)
		}
	};
}

function roundPhase(p: {
	moves: number;
	avgCpLoss: number;
	blunderRate: number;
	inaccuracyRate: number;
}) {
	return {
		moves: p.moves,
		avgCpLoss: Math.round(p.avgCpLoss * 10) / 10,
		blunderRate: round(p.blunderRate),
		inaccuracyRate: round(p.inaccuracyRate)
	};
}

function toBaselineCriticalMoments(moves: EvalMoveResult[]): BaselineCriticalMoments {
	const cm = buildCriticalMoments(moves, null);
	return {
		conversionRate: round(cm.conversion.rate),
		conversionGames: cm.conversion.games,
		defenseRate: round(cm.defense.rate),
		defenseGames: cm.defense.games,
		equalityWinRate: round(cm.equality.winRate),
		equalityLossRate: round(cm.equality.lossRate),
		equalityGames: cm.equality.games
	};
}

function toBaselineClockSpend(
	games: ClassifiedGame[],
	moves: EvalMoveResult[]
): BaselineClockSpend {
	const cs = buildClockSpend(games, moves, null);
	return {
		opening: round(cs.alloc.opening),
		middle: round(cs.alloc.middle),
		end: round(cs.alloc.end),
		blunderOpening: round(cs.blunders.opening),
		blunderMiddle: round(cs.blunders.middle),
		blunderEnd: round(cs.blunders.end)
	};
}

// Keep unused type imports from triggering lint when tree-shaken.
void (null as unknown as Phase);

interface Acc {
	totalMoves: number;
	games: number;
	forcing: number;
	capture: number;
	pawnPlay: number;
	queenside: number;
	castledGames: number;
	tensioned: number;
	released: number;
	created: number;
}

function emptyAcc(): Acc {
	return {
		totalMoves: 0,
		games: 0,
		forcing: 0,
		capture: 0,
		pawnPlay: 0,
		queenside: 0,
		castledGames: 0,
		tensioned: 0,
		released: 0,
		created: 0
	};
}

function absorb(acc: Acc, g: ClassifiedGame) {
	acc.games += 1;
	let castled = false;
	for (const m of g.moves) {
		acc.totalMoves += 1;
		if (m.isCapture || m.isCheck) acc.forcing += 1;
		if (m.isCapture) acc.capture += 1;
		if (m.isPawnMove) acc.pawnPlay += 1;
		if (m.toFile <= 3) acc.queenside += 1;
		if (m.tensionBefore > 0) {
			acc.tensioned += 1;
			if (m.tensionAction === 'released') acc.released += 1;
		}
		if (m.tensionAction === 'created') acc.created += 1;
		if (isEarlyCastle(m)) castled = true;
	}
	if (castled) acc.castledGames += 1;
}

function isEarlyCastle(m: MoveFeatures): boolean {
	return m.isCastle && m.ply < 40;
}

/**
 * Pick the user's most-played speed in this scan; used as the calibration
 * bucket. Mixed-speed users get one bucket per speed (run calibrate
 * separately for each — todo, single-bucket per call for v1).
 */
function primarySpeed(games: ClassifiedGame[]): string | undefined {
	const counts = new Map<string, number>();
	for (const g of games) counts.set(g.speed, (counts.get(g.speed) ?? 0) + 1);
	let best: { speed: string; count: number } | null = null;
	for (const [speed, count] of counts) {
		if (!best || count > best.count) best = { speed, count };
	}
	return best?.speed;
}

/**
 * Pull each game's opponent name + rating, dedup, restrict to the rating
 * window and the user's primary speed.
 */
function collectOpponentSeeds(
	games: ClassifiedGame[],
	ratingMin: number,
	ratingMax: number,
	speed: string
): OpponentSeed[] {
	const seen = new Map<string, OpponentSeed>();
	for (const g of games) {
		if (g.speed !== speed) continue;
		if (g.opponentRating == null) continue;
		if (g.opponentRating < ratingMin || g.opponentRating > ratingMax) continue;
		if (!g.opponentUsername) continue;
		const source: 'lichess' | 'chesscom' = g.gameId.startsWith('cc-') ? 'chesscom' : 'lichess';
		const key = `${source}:${g.opponentUsername.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.set(key, { source, username: g.opponentUsername, rating: g.opponentRating });
	}
	// Prefer opponents whose rating is closest to the user's centre.
	const centre = (ratingMin + ratingMax) / 2;
	return [...seen.values()].sort(
		(a, b) => Math.abs(a.rating - centre) - Math.abs(b.rating - centre)
	);
}

function bumpSkip(map: Map<string, number>, key: string) {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function round(x: number): number {
	return Math.round(x * 1000) / 1000;
}

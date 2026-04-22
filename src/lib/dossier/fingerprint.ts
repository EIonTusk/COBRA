/**
 * Aggregate per-move features across many games into a DossierFingerprint.
 *
 * The shape is intentionally small for v1: rates per phase along a few
 * decision-type axes. Each axis is normalized to [0, 1] so the same
 * structure can be plotted on a radar.
 *
 * Baselines (NEUTRAL_BASELINE) are eyeballed from typical online play —
 * they're the "average human" reference point so we can describe a user
 * as forcing-heavy or forcing-light *relative to* the population. They
 * should be replaced with empirical numbers once we've scanned enough
 * games to compute them honestly.
 */

import type { ClassifiedGame, MoveFeatures, Phase } from './classify';
import { ecoFamily, type OpeningFamily } from './openings';

export type { ClassifiedGame } from './classify';
export type { OpeningFamily } from './openings';

export interface AxisRates {
	/** Captures + checks (de-duplicated). Higher = more forcing. */
	forcing: number;
	/** Captures only — rough proxy for willingness to simplify on contact. */
	capture: number;
	/** Pawn moves / total. Higher = more pawn-driven (strategic, structural). */
	pawnPlay: number;
	/** Queenside-target moves (to-file ∈ a-d). Indicates side-of-board bias. */
	queenside: number;
	/** Castled before move 20. 1 if castled early, 0 if not. */
	earlyCastle: number;
}

export interface PhaseProfile extends AxisRates {
	moves: number;
}

export interface TensionStats {
	/** Moves where tension existed before the move. */
	tensionedMoves: number;
	/** Among tensioned moves: fraction where the user resolved the tension. */
	releaseRate: number;
	/** Fraction of all moves that newly created pawn-pawn contact. */
	creationRate: number;
}

export type ResultKey = 'win' | 'loss' | 'draw';
export type ClockBucket = 'low' | 'mid' | 'high';

export interface OpeningProfile extends AxisRates {
	family: OpeningFamily;
	games: number;
	moves: number;
	wins: number;
	losses: number;
	draws: number;
	winRate: number;
}

export interface DossierFingerprint {
	gamesAnalyzed: number;
	totalUserMoves: number;
	overall: AxisRates & { moves: number };
	byPhase: Record<Phase, PhaseProfile>;
	byColor: Record<'white' | 'black', AxisRates & { games: number }>;
	bySpeed: Record<string, AxisRates & { games: number }>;
	/**
	 * Axes split by game outcome. Diagnostic of "how do I play differently
	 * in games I lose vs win" — if forcing rate is +10pp in losses, that's
	 * a behavioral leak that pure overall stats hide.
	 */
	byResult: Record<ResultKey, AxisRates & { games: number; moves: number }>;
	/**
	 * Axes split by remaining clock at the time of the move. low <10s,
	 * mid <60s, high otherwise. Reveals panic-attack patterns in blitz —
	 * e.g. forcing rate jumping under time pressure.
	 */
	byClock: Record<ClockBucket, AxisRates & { moves: number }>;
	/**
	 * Per-opening-family axes + win rate, sorted by game count desc. Lets
	 * the user see which families they actually score in vs which they
	 * just play often. Families with <5 games are folded into "Other".
	 */
	byOpening: OpeningProfile[];
	tension: TensionStats;
	results: { win: number; loss: number; draw: number };
	avgUserRating: number | null;
}

/**
 * Baseline loaded from `baseline.json`. Two layers:
 *
 *   - **Root** (`axes` + `tension`): the legacy fallback. Starts eyeballed,
 *     replaced once an empirical run has populated it.
 *   - **Buckets** (`buckets[]`): rating- and speed-conditioned baselines
 *     produced by the snowball mode of `scripts/compute-dossier-baseline.mjs`.
 *     `pickBaseline()` selects the bucket whose (ratingMin, ratingMax)
 *     contains the user's average rating and whose `bucket` matches the
 *     user's primary speed; falls back to root if none matches.
 */
import baselineData from './baseline.json';

interface BaselineBucketJson {
	bucket?: string;
	ratingMin?: number | null;
	ratingMax?: number | null;
	mode?: 'direct' | 'snowball' | 'self-calibrated';
	games?: number;
	totalMoves?: number;
	axes: AxisRates;
	/** Optional per-axis SD of the peer sample; enables z-score comparison. */
	axesSd?: AxisRates;
	tension: { releaseRate: number; creationRate: number };
	tensionSd?: { releaseRate: number; creationRate: number };
	/** ISO string from the offline script, or epoch ms from a runtime calibration. */
	computedAt?: string | number;
	seedUsers?: string[];
	sampledUsers?: number;
	/**
	 * Optional v2 peer benchmark fields — mirror the optional fields on
	 * StoredBaselineBucket so runtime calibration payloads can flow
	 * straight into `pickBaseline()` without a translation step.
	 */
	evalByPhaseColor?: BaselinePhaseColorJson;
	criticalMoments?: BaselineCriticalMomentsJson;
	clockSpend?: BaselineClockSpendJson;
	evalGamesSampled?: number;
	evalMovesAnalysed?: number;
}

export interface BaselinePhaseStatsJson {
	moves: number;
	avgCpLoss: number;
	/** Population SD of per-move CP loss in this bucket; enables z-scores. */
	avgCpLossSd?: number;
	blunderRate: number;
	inaccuracyRate: number;
}

export interface BaselinePhaseColorJson {
	opening: { white: BaselinePhaseStatsJson; black: BaselinePhaseStatsJson };
	middle: { white: BaselinePhaseStatsJson; black: BaselinePhaseStatsJson };
	end: { white: BaselinePhaseStatsJson; black: BaselinePhaseStatsJson };
}

export interface BaselineCriticalMomentsJson {
	conversionRate: number;
	conversionGames: number;
	defenseRate: number;
	defenseGames: number;
	equalityWinRate: number;
	equalityLossRate: number;
	equalityGames: number;
}

export interface BaselineClockSpendJson {
	opening: number;
	middle: number;
	end: number;
	blunderOpening: number;
	blunderMiddle: number;
	blunderEnd: number;
}

const baselineRaw = baselineData as unknown as {
	source: 'eyeballed' | 'empirical';
	sampledFrom?: string[];
	games?: number;
	computedAt?: string | null;
	axes: AxisRates;
	tension: { releaseRate: number; creationRate: number };
	buckets?: BaselineBucketJson[];
	evalByPhaseColor?: BaselinePhaseColorJson;
	criticalMoments?: BaselineCriticalMomentsJson;
	clockSpend?: BaselineClockSpendJson;
};

const NEUTRAL_BASELINE: AxisRates = baselineRaw.axes;
const TENSION_BASELINE: TensionStats = {
	tensionedMoves: 0,
	releaseRate: baselineRaw.tension.releaseRate,
	creationRate: baselineRaw.tension.creationRate
};
const BASELINE_BUCKETS: BaselineBucketJson[] = baselineRaw.buckets ?? [];

/**
 * Runtime baselines injected by the app — typically self-calibrated
 * per-user buckets loaded from IndexedDB. Checked **before** the static
 * buckets so a self-calibrated value always beats the shipped default.
 */
let runtimeBuckets: BaselineBucketJson[] = [];
export function setRuntimeBaselines(buckets: BaselineBucketJson[]): void {
	runtimeBuckets = buckets;
}
export function getRuntimeBaselines(): BaselineBucketJson[] {
	return runtimeBuckets;
}

export const BASELINE_META = {
	source: baselineRaw.source,
	sampledFrom: baselineRaw.sampledFrom,
	games: baselineRaw.games,
	computedAt: baselineRaw.computedAt ?? undefined,
	bucketCount: BASELINE_BUCKETS.length
};

export interface PickedBaseline {
	axes: AxisRates;
	/** Per-axis population SD for the picked peer bucket; undefined on eyeballed fallback. */
	axesSd?: AxisRates;
	tension: TensionStats;
	tensionSd?: { releaseRate: number; creationRate: number };
	source: 'eyeballed' | 'empirical' | 'bucketed' | 'self-calibrated';
	bucket: BaselineBucketJson | null;
	/** v2 peer fields — present only when the picked bucket carries them. */
	evalByPhaseColor?: BaselinePhaseColorJson;
	criticalMoments?: BaselineCriticalMomentsJson;
	clockSpend?: BaselineClockSpendJson;
	/** Peer sample size (games) for methodology disclosure. */
	peerGames?: number;
}

/**
 * Pick the most specific baseline that fits the user. Resolution order:
 *
 *   1. Runtime buckets (self-calibrated, loaded from IDB on app boot).
 *   2. Static buckets shipped in baseline.json (snowballed dev-time runs).
 *   3. Root values in baseline.json (legacy eyeballed fallback).
 *
 * Within each layer we prefer rating-window match + same speed, then
 * narrowest band. The runtime layer always wins because it's been
 * computed against this specific user's actual peers.
 */
export function pickBaseline(rating: number | null, speed?: string): PickedBaseline {
	// v2 peer fields live on the root of baseline.json as eyeballed
	// defaults. Older buckets (including pre-v2 self-calibrated ones the
	// user may have accumulated) omit them, which would otherwise leave
	// every scorecard tile saying "no peer data". Fall back to the root
	// values per-field so a v1-only bucket still produces peer deltas.
	const rootEval = baselineRaw.evalByPhaseColor;
	const rootCritical = baselineRaw.criticalMoments;
	const rootClock = baselineRaw.clockSpend;

	if (rating != null) {
		const fromRuntime = pickFrom(runtimeBuckets, rating, speed);
		if (fromRuntime) {
			return {
				axes: fromRuntime.axes,
				axesSd: fromRuntime.axesSd,
				tension: { tensionedMoves: 0, ...fromRuntime.tension },
				tensionSd: fromRuntime.tensionSd,
				source: 'self-calibrated',
				bucket: fromRuntime,
				evalByPhaseColor: fromRuntime.evalByPhaseColor ?? rootEval,
				criticalMoments: fromRuntime.criticalMoments ?? rootCritical,
				clockSpend: fromRuntime.clockSpend ?? rootClock,
				peerGames: fromRuntime.games
			};
		}
		const fromStatic = pickFrom(BASELINE_BUCKETS, rating, speed);
		if (fromStatic) {
			return {
				axes: fromStatic.axes,
				axesSd: fromStatic.axesSd,
				tension: { tensionedMoves: 0, ...fromStatic.tension },
				tensionSd: fromStatic.tensionSd,
				source: 'bucketed',
				bucket: fromStatic,
				evalByPhaseColor: fromStatic.evalByPhaseColor ?? rootEval,
				criticalMoments: fromStatic.criticalMoments ?? rootCritical,
				clockSpend: fromStatic.clockSpend ?? rootClock,
				peerGames: fromStatic.games
			};
		}
	}
	return {
		axes: NEUTRAL_BASELINE,
		tension: TENSION_BASELINE,
		source: baselineRaw.source,
		bucket: null,
		evalByPhaseColor: rootEval,
		criticalMoments: rootCritical,
		clockSpend: rootClock
	};
}

function pickFrom(
	buckets: BaselineBucketJson[],
	rating: number,
	speed: string | undefined
): BaselineBucketJson | null {
	if (buckets.length === 0) return null;
	const ratingMatches = buckets.filter((b) => {
		const lo = b.ratingMin ?? -Infinity;
		const hi = b.ratingMax ?? Infinity;
		return rating >= lo && rating <= hi;
	});
	const speedMatches = speed
		? ratingMatches.filter((b) => !b.bucket || b.bucket === speed)
		: ratingMatches;
	const candidates = speedMatches.length > 0 ? speedMatches : ratingMatches;
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => bandWidth(a) - bandWidth(b));
	return candidates[0];
}

function bandWidth(b: BaselineBucketJson): number {
	const lo = b.ratingMin ?? -Infinity;
	const hi = b.ratingMax ?? Infinity;
	if (!isFinite(lo) || !isFinite(hi)) return Infinity;
	return hi - lo;
}

/**
 * Pick the speed bucket the user plays most — used as the `speed` arg to
 * `pickBaseline()` so we don't compare a bullet player to a rapid baseline.
 */
export function primarySpeed(fp: DossierFingerprint): string | undefined {
	let best: { speed: string; games: number } | null = null;
	for (const [speed, row] of Object.entries(fp.bySpeed)) {
		if (!best || row.games > best.games) best = { speed, games: row.games };
	}
	return best?.speed;
}

export function fingerprintFromGames(games: ClassifiedGame[]): DossierFingerprint {
	const overall = emptyAcc();
	const byPhase: Record<Phase, Acc> = {
		opening: emptyAcc(),
		middle: emptyAcc(),
		end: emptyAcc()
	};
	const byColor = {
		white: emptyGameAcc(),
		black: emptyGameAcc()
	};
	const bySpeed: Record<string, GameAcc> = {};
	const byResult: Record<ResultKey, GameAcc> = {
		win: emptyGameAcc(),
		loss: emptyGameAcc(),
		draw: emptyGameAcc()
	};
	const byClock: Record<ClockBucket, Acc> = {
		low: emptyAcc(),
		mid: emptyAcc(),
		high: emptyAcc()
	};
	const byOpening = new Map<OpeningFamily, OpeningAcc>();
	const results = { win: 0, loss: 0, draw: 0 };

	let ratingSum = 0;
	let ratingCount = 0;

	let tensionedMoves = 0;
	let releasedMoves = 0;
	let createdMoves = 0;
	let totalMoves = 0;

	for (const g of games) {
		results[g.result] += 1;
		if (g.userRating != null) {
			ratingSum += g.userRating;
			ratingCount += 1;
		}

		const colorAcc = byColor[g.color];
		colorAcc.games += 1;
		const speedAcc = (bySpeed[g.speed] ??= emptyGameAcc());
		speedAcc.games += 1;
		const resultAcc = byResult[g.result];
		resultAcc.games += 1;
		const family = ecoFamily(g.eco);
		let openingAcc = byOpening.get(family);
		if (!openingAcc) {
			openingAcc = emptyOpeningAcc(family);
			byOpening.set(family, openingAcc);
		}
		openingAcc.games += 1;
		if (g.result === 'win') openingAcc.wins += 1;
		else if (g.result === 'loss') openingAcc.losses += 1;
		else openingAcc.draws += 1;

		// Track castled-before-ply-20 once per game.
		const castled = g.moves.some((m) => m.isCastle && m.ply < 40);

		colorAcc.castledGames += castled ? 1 : 0;
		speedAcc.castledGames += castled ? 1 : 0;
		resultAcc.castledGames += castled ? 1 : 0;

		for (const m of g.moves) {
			accAdd(overall, m);
			accAdd(byPhase[m.phase], m);
			accAddRates(colorAcc, m);
			accAddRates(speedAcc, m);
			accAddRates(resultAcc, m);
			accAdd(openingAcc, m);
			if (m.clockBucket !== 'none') accAdd(byClock[m.clockBucket], m);
			totalMoves += 1;
			if (m.tensionBefore > 0) {
				tensionedMoves += 1;
				if (m.tensionAction === 'released') releasedMoves += 1;
			}
			if (m.tensionAction === 'created') createdMoves += 1;
		}
	}

	const tension: TensionStats = {
		tensionedMoves,
		releaseRate: tensionedMoves > 0 ? releasedMoves / tensionedMoves : 0,
		creationRate: totalMoves > 0 ? createdMoves / totalMoves : 0
	};

	return {
		gamesAnalyzed: games.length,
		totalUserMoves: overall.moves,
		overall: finalize(overall),
		byPhase: {
			opening: finalize(byPhase.opening),
			middle: finalize(byPhase.middle),
			end: finalize(byPhase.end)
		},
		byColor: {
			white: finalizeGame(byColor.white),
			black: finalizeGame(byColor.black)
		},
		bySpeed: Object.fromEntries(Object.entries(bySpeed).map(([k, v]) => [k, finalizeGame(v)])),
		byResult: {
			win: finalizeResult(byResult.win),
			loss: finalizeResult(byResult.loss),
			draw: finalizeResult(byResult.draw)
		},
		byClock: {
			low: finalizeClock(byClock.low),
			mid: finalizeClock(byClock.mid),
			high: finalizeClock(byClock.high)
		},
		byOpening: finalizeOpenings(byOpening),
		tension,
		results,
		avgUserRating: ratingCount > 0 ? Math.round(ratingSum / ratingCount) : null
	};
}

function finalizeResult(a: GameAcc): AxisRates & { games: number; moves: number } {
	const safe = a.moves || 1;
	return {
		games: a.games,
		moves: a.moves,
		forcing: a.forcing / safe,
		capture: a.capture / safe,
		pawnPlay: a.pawnPlay / safe,
		queenside: a.queenside / safe,
		earlyCastle: a.games > 0 ? a.castledGames / a.games : 0
	};
}

function finalizeClock(a: Acc): AxisRates & { moves: number } {
	const safe = a.moves || 1;
	return {
		moves: a.moves,
		forcing: a.forcing / safe,
		capture: a.capture / safe,
		pawnPlay: a.pawnPlay / safe,
		queenside: a.queenside / safe,
		earlyCastle: 0
	};
}

interface OpeningAcc extends Acc {
	family: OpeningFamily;
	games: number;
	wins: number;
	losses: number;
	draws: number;
}

function emptyOpeningAcc(family: OpeningFamily): OpeningAcc {
	return { ...emptyAcc(), family, games: 0, wins: 0, losses: 0, draws: 0 };
}

function finalizeOpenings(map: Map<OpeningFamily, OpeningAcc>): OpeningProfile[] {
	const profiles: OpeningProfile[] = [];
	for (const a of map.values()) {
		const safe = a.moves || 1;
		const decided = a.wins + a.losses + a.draws;
		profiles.push({
			family: a.family,
			games: a.games,
			moves: a.moves,
			wins: a.wins,
			losses: a.losses,
			draws: a.draws,
			winRate: decided > 0 ? (a.wins + 0.5 * a.draws) / decided : 0,
			forcing: a.forcing / safe,
			capture: a.capture / safe,
			pawnPlay: a.pawnPlay / safe,
			queenside: a.queenside / safe,
			earlyCastle: 0
		});
	}
	profiles.sort((x, y) => y.games - x.games);
	return profiles;
}

interface Acc {
	moves: number;
	forcing: number;
	capture: number;
	pawnPlay: number;
	queenside: number;
}

interface GameAcc extends Acc {
	games: number;
	castledGames: number;
}

function emptyAcc(): Acc {
	return { moves: 0, forcing: 0, capture: 0, pawnPlay: 0, queenside: 0 };
}

function emptyGameAcc(): GameAcc {
	return { ...emptyAcc(), games: 0, castledGames: 0 };
}

function accAdd(acc: Acc, m: MoveFeatures) {
	acc.moves += 1;
	if (m.isCapture || m.isCheck) acc.forcing += 1;
	if (m.isCapture) acc.capture += 1;
	if (m.isPawnMove) acc.pawnPlay += 1;
	if (m.toFile <= 3) acc.queenside += 1;
}

function accAddRates(acc: GameAcc, m: MoveFeatures) {
	accAdd(acc, m);
}

function finalize(a: Acc): PhaseProfile {
	const safe = a.moves || 1;
	return {
		moves: a.moves,
		forcing: a.forcing / safe,
		capture: a.capture / safe,
		pawnPlay: a.pawnPlay / safe,
		queenside: a.queenside / safe,
		earlyCastle: 0
	};
}

function finalizeGame(a: GameAcc): AxisRates & { games: number } {
	const safe = a.moves || 1;
	return {
		games: a.games,
		forcing: a.forcing / safe,
		capture: a.capture / safe,
		pawnPlay: a.pawnPlay / safe,
		queenside: a.queenside / safe,
		earlyCastle: a.games > 0 ? a.castledGames / a.games : 0
	};
}

export interface AxisHighlight {
	axis: keyof AxisRates;
	value: number;
	baseline: number;
	delta: number;
	direction: 'high' | 'low';
}

/**
 * Pick the axes where the fingerprint deviates most from the baseline
 * that best fits the user's rating + speed. Used for the headline
 * "you're X-heavy / Y-light" callouts. Without a per-rating baseline a
 * 1500-rated player would always look "low forcing" vs the GM-derived
 * defaults — `pickBaseline` snaps that comparison to peers.
 */
export function highlightAxes(fp: DossierFingerprint, top = 3): AxisHighlight[] {
	const o = fp.overall;
	const baseline = pickBaseline(fp.avgUserRating, primarySpeed(fp));
	const axes: (keyof AxisRates)[] = ['forcing', 'capture', 'pawnPlay', 'queenside', 'earlyCastle'];
	const overallEarlyCastle =
		(fp.byColor.white.earlyCastle * fp.byColor.white.games +
			fp.byColor.black.earlyCastle * fp.byColor.black.games) /
		Math.max(1, fp.byColor.white.games + fp.byColor.black.games);

	const rows: AxisHighlight[] = axes.map((axis) => {
		const value = axis === 'earlyCastle' ? overallEarlyCastle : o[axis];
		const baselineValue = baseline.axes[axis];
		const delta = value - baselineValue;
		return {
			axis,
			value,
			baseline: baselineValue,
			delta,
			direction: delta >= 0 ? 'high' : 'low'
		};
	});

	rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
	return rows.slice(0, top);
}

export const DOSSIER_BASELINE = NEUTRAL_BASELINE;
export const DOSSIER_TENSION_BASELINE = TENSION_BASELINE;

export type DriftAxisKey = keyof AxisRates | 'tensionRelease' | 'tensionCreate';

export interface DriftAxis {
	axis: DriftAxisKey;
	recent: number;
	prior: number;
	delta: number;
}

export interface DriftResults {
	recent: { win: number; loss: number; draw: number; winRate: number };
	prior: { win: number; loss: number; draw: number; winRate: number };
	winRateDelta: number;
}

export interface WeeklyAxisSample {
	weekStart: number;
	games: number;
	axes: AxisRates;
}

export interface FingerprintDrift {
	recentGames: number;
	priorGames: number;
	recentRange: { fromMs: number; toMs: number };
	priorRange: { fromMs: number; toMs: number };
	axes: DriftAxis[];
	results: DriftResults;
	/**
	 * Per-week samples covering both windows (oldest → newest). One row
	 * per ISO week with ≥3 games. Used by the sparkline UI to show the
	 * trajectory of each axis instead of just two endpoints.
	 */
	weekly: WeeklyAxisSample[];
}

/**
 * Split games into a "recent" window (last `recentDays`) and a "prior"
 * window (the `priorDays` immediately before that), compute fingerprints
 * for each, and surface per-axis deltas. Returns null if either window
 * has too few games (< 10) to be meaningful.
 */
export function computeDrift(
	games: ClassifiedGame[],
	recentDays = 30,
	priorDays = 90
): FingerprintDrift | null {
	if (games.length === 0) return null;
	const now = Date.now();
	const dayMs = 24 * 60 * 60 * 1000;
	const recentCutoff = now - recentDays * dayMs;
	const priorCutoff = recentCutoff - priorDays * dayMs;

	const recent = games.filter((g) => g.playedAt >= recentCutoff);
	const prior = games.filter((g) => g.playedAt < recentCutoff && g.playedAt >= priorCutoff);
	if (recent.length < 10 || prior.length < 10) return null;

	const recentFp = fingerprintFromGames(recent);
	const priorFp = fingerprintFromGames(prior);
	const baseAxes: (keyof AxisRates)[] = [
		'forcing',
		'capture',
		'pawnPlay',
		'queenside',
		'earlyCastle'
	];

	const recentEarly = weightedEarlyCastle(recentFp);
	const priorEarly = weightedEarlyCastle(priorFp);

	const out: DriftAxis[] = baseAxes.map((axis) => {
		const r = axis === 'earlyCastle' ? recentEarly : recentFp.overall[axis];
		const p = axis === 'earlyCastle' ? priorEarly : priorFp.overall[axis];
		return { axis, recent: r, prior: p, delta: r - p };
	});
	out.push({
		axis: 'tensionRelease',
		recent: recentFp.tension.releaseRate,
		prior: priorFp.tension.releaseRate,
		delta: recentFp.tension.releaseRate - priorFp.tension.releaseRate
	});
	out.push({
		axis: 'tensionCreate',
		recent: recentFp.tension.creationRate,
		prior: priorFp.tension.creationRate,
		delta: recentFp.tension.creationRate - priorFp.tension.creationRate
	});
	out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

	const recentR = winRate(recentFp.results);
	const priorR = winRate(priorFp.results);

	return {
		recentGames: recent.length,
		priorGames: prior.length,
		recentRange: { fromMs: recentCutoff, toMs: now },
		priorRange: { fromMs: priorCutoff, toMs: recentCutoff },
		axes: out,
		results: {
			recent: { ...recentFp.results, winRate: recentR },
			prior: { ...priorFp.results, winRate: priorR },
			winRateDelta: recentR - priorR
		},
		weekly: weeklySamples(games.filter((g) => g.playedAt >= priorCutoff))
	};
}

/** Floor a timestamp to the start of its UTC ISO week (Monday 00:00). */
function weekStartOf(ts: number): number {
	const d = new Date(ts);
	const day = d.getUTCDay(); // 0 = Sun, 1 = Mon, ...
	const offset = (day + 6) % 7; // days since Monday
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset);
}

function weeklySamples(games: ClassifiedGame[]): WeeklyAxisSample[] {
	if (games.length === 0) return [];
	const buckets = new Map<number, ClassifiedGame[]>();
	for (const g of games) {
		const key = weekStartOf(g.playedAt);
		const arr = buckets.get(key) ?? [];
		arr.push(g);
		buckets.set(key, arr);
	}
	const out: WeeklyAxisSample[] = [];
	for (const [weekStart, gs] of buckets) {
		if (gs.length < 3) continue;
		const fp = fingerprintFromGames(gs);
		out.push({
			weekStart,
			games: gs.length,
			axes: {
				forcing: fp.overall.forcing,
				capture: fp.overall.capture,
				pawnPlay: fp.overall.pawnPlay,
				queenside: fp.overall.queenside,
				earlyCastle: weightedEarlyCastle(fp)
			}
		});
	}
	out.sort((a, b) => a.weekStart - b.weekStart);
	return out;
}

function winRate(r: { win: number; loss: number; draw: number }): number {
	const total = r.win + r.loss + r.draw;
	if (total === 0) return 0;
	return (r.win + 0.5 * r.draw) / total;
}

function weightedEarlyCastle(fp: DossierFingerprint): number {
	const w = fp.byColor.white;
	const b = fp.byColor.black;
	const total = w.games + b.games;
	if (total === 0) return 0;
	return (w.earlyCastle * w.games + b.earlyCastle * b.games) / total;
}

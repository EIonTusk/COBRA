/**
 * Per-opening diagnostic. Joins the v2 per-move CP losses
 * (`EvalMoveResult`) with the classified games so we can see not just
 * *that* the Sicilian wins more often, but *where* the CP loss
 * diverges inside that family — opening / middlegame / endgame.
 *
 * Rows are keyed by **(family, color)**. An ECO family alone is not
 * enough: the Caro-Kann faced as White (you against 1...c6) is a
 * different data point from the Caro-Kann played as Black (you
 * choosing 1...c6). Grouping by ECO only would blend wins you earned
 * by preparing against 1...c6 with losses you took choosing it — and
 * vice versa.
 *
 * Output is three lists (best / worst / rest) ranked by a composite of
 * win-rate delta vs the user's overall and CP-loss delta vs the user's
 * overall CP loss. Each row carries a one-line auto-generated "why"
 * sentence so the UI can say "your Sicilian (as Black) wins because
 * your middle CP loss drops to 48 (vs 72 overall)."
 *
 * Cells below `MIN_GAMES_FOR_SIGNAL` games are dropped from the ranked
 * view — too noisy to act on.
 */
import type { ClassifiedGame, Phase } from './classify';
import type { EvalMoveResult } from './evalAxes';
import type { Color } from '$lib/types';
import { chooserForOpeningName, parseOpeningName } from './openings';

export type OpeningVerdict = 'strong' | 'weak' | 'neutral';
/**
 * Whether the user *chose* the opening (matches the chooser side) or
 * *faced* it. Used for the row label so "Caro-Kann" with White is
 * correctly shown as "Faced", not "Played".
 */
export type OpeningRole = 'played' | 'faced' | 'neutral';

export interface OpeningPhaseStats {
	moves: number;
	avgCpLoss: number;
}

/** Main-variation-level sub-row hanging off a family row. */
export interface OpeningVariationRow {
	/** Full "Family: Main variation" label. */
	label: string;
	games: number;
	wins: number;
	losses: number;
	draws: number;
	winRate: number;
	avgCpLoss: number | null;
}

export interface OpeningProfileRow {
	/**
	 * Opening family root — derived from the PGN `[Opening]` tag's
	 * pre-colon segment ("French Defense" from "French Defense: Winawer
	 * Variation"). Rolling up the variations here keeps the main list
	 * representative even when a single family fragments across many
	 * sub-lines. Falls back to the coarse ECO family when the header is
	 * missing.
	 */
	opening: string;
	/** Side the user played this opening on; avoids blending "faced it" with "chose it". */
	color: Color;
	/** Did the user *choose* this opening, or *face* it? */
	role: OpeningRole;
	games: number;
	wins: number;
	losses: number;
	draws: number;
	winRate: number;
	/** winRate - user's overall winRate. */
	winRateDelta: number;
	avgCpLoss: number | null;
	/** avgCpLoss - user's overall avgCpLoss. Null when v2 data absent. */
	cpLossDelta: number | null;
	byPhase: Record<Phase, OpeningPhaseStats> | null;
	why: string;
	verdict: OpeningVerdict;
	/** Top main variations under this family (≥3 games), sorted desc. */
	variations: OpeningVariationRow[];
}

export interface OpeningProfileReport {
	rows: OpeningProfileRow[];
	best: OpeningProfileRow[];
	worst: OpeningProfileRow[];
	neutral: OpeningProfileRow[];
	userAvgCpLoss: number | null;
	userWinRate: number;
}

const MIN_GAMES_FOR_SIGNAL = 5;
const MIN_GAMES_FOR_VARIATION = 3;
const STRONG_WR = 0.06;
const WEAK_WR = -0.06;
const STRONG_CP = -10;
const WEAK_CP = 20;

export function buildOpeningProfile(
	classified: ClassifiedGame[],
	moves: EvalMoveResult[] | null
): OpeningProfileReport {
	interface Acc {
		games: number;
		wins: number;
		losses: number;
		draws: number;
		moves: number;
		cpSum: number;
		phaseMoves: Record<Phase, number>;
		phaseCp: Record<Phase, number>;
	}
	type FamilyAcc = Acc & { family: string; eco: string | null; color: Color };
	type VariationAcc = Acc & { family: string; label: string; color: Color };
	const fam = new Map<string, FamilyAcc>();
	const variations = new Map<string, VariationAcc>();
	const emptyAcc = (): Acc => ({
		games: 0,
		wins: 0,
		losses: 0,
		draws: 0,
		moves: 0,
		cpSum: 0,
		phaseMoves: { opening: 0, middle: 0, end: 0 } as Record<Phase, number>,
		phaseCp: { opening: 0, middle: 0, end: 0 } as Record<Phase, number>
	});
	const familyKey = (family: string, color: Color) => `${color}|${family}`;
	const variationKey = (label: string, color: Color) => `${color}|${label}`;

	let totalWins = 0;
	let totalDraws = 0;
	let totalLosses = 0;
	// Maps game → its (family-key, variation-key) so the v2 move pass
	// can credit CP loss to both the family and its variation.
	const gameKeys = new Map<string, { fam: string; vari: string | null }>();
	for (const g of classified) {
		const { family, label } = parseOpeningName(g.openingName, g.eco);
		const famK = familyKey(family, g.color);
		let famAcc = fam.get(famK);
		if (!famAcc) {
			famAcc = { ...emptyAcc(), family, eco: g.eco, color: g.color };
			fam.set(famK, famAcc);
		}
		tallyGame(famAcc, g.result);
		totalWins += g.result === 'win' ? 1 : 0;
		totalLosses += g.result === 'loss' ? 1 : 0;
		totalDraws += g.result === 'draw' ? 1 : 0;

		let variK: string | null = null;
		if (label !== family) {
			variK = variationKey(label, g.color);
			let variAcc = variations.get(variK);
			if (!variAcc) {
				variAcc = { ...emptyAcc(), family, label, color: g.color };
				variations.set(variK, variAcc);
			}
			tallyGame(variAcc, g.result);
		}
		gameKeys.set(g.gameId, { fam: famK, vari: variK });
	}

	let userMoves = 0;
	let userCp = 0;
	if (moves) {
		for (const m of moves) {
			const keys = gameKeys.get(m.gameId);
			if (!keys) continue;
			const famAcc = fam.get(keys.fam);
			if (famAcc) {
				famAcc.moves += 1;
				famAcc.cpSum += m.cpLoss;
				famAcc.phaseMoves[m.phase] += 1;
				famAcc.phaseCp[m.phase] += m.cpLoss;
			}
			if (keys.vari) {
				const variAcc = variations.get(keys.vari);
				if (variAcc) {
					variAcc.moves += 1;
					variAcc.cpSum += m.cpLoss;
				}
			}
			userMoves += 1;
			userCp += m.cpLoss;
		}
	}

	const userAvgCpLoss = userMoves > 0 ? userCp / userMoves : null;
	const decided = totalWins + totalDraws + totalLosses;
	const userWinRate = decided > 0 ? (totalWins + 0.5 * totalDraws) / decided : 0;

	const rows: OpeningProfileRow[] = [];
	for (const acc of fam.values()) {
		if (acc.games < MIN_GAMES_FOR_SIGNAL) continue;
		const d = acc.wins + acc.draws + acc.losses;
		const winRate = d > 0 ? (acc.wins + 0.5 * acc.draws) / d : 0;
		const winRateDelta = winRate - userWinRate;
		const avgCpLoss = acc.moves > 0 ? acc.cpSum / acc.moves : null;
		const cpLossDelta =
			userAvgCpLoss != null && avgCpLoss != null ? avgCpLoss - userAvgCpLoss : null;

		let byPhase: Record<Phase, OpeningPhaseStats> | null = null;
		if (acc.moves > 0) {
			byPhase = {
				opening: phaseStats(acc.phaseMoves.opening, acc.phaseCp.opening),
				middle: phaseStats(acc.phaseMoves.middle, acc.phaseCp.middle),
				end: phaseStats(acc.phaseMoves.end, acc.phaseCp.end)
			};
		}

		const verdict = verdictFor(winRateDelta, cpLossDelta);
		const why = buildWhy(verdict, winRateDelta, cpLossDelta, byPhase, userAvgCpLoss);

		const chooser = chooserForOpeningName(acc.family, acc.eco);
		const role: OpeningRole =
			chooser === 'either' ? 'neutral' : chooser === acc.color ? 'played' : 'faced';

		// Collect top variations that sat under this family+color.
		const vars: OpeningVariationRow[] = [];
		for (const v of variations.values()) {
			if (v.family !== acc.family || v.color !== acc.color) continue;
			if (v.games < MIN_GAMES_FOR_VARIATION) continue;
			const vd = v.wins + v.draws + v.losses;
			vars.push({
				label: v.label,
				games: v.games,
				wins: v.wins,
				losses: v.losses,
				draws: v.draws,
				winRate: vd > 0 ? (v.wins + 0.5 * v.draws) / vd : 0,
				avgCpLoss: v.moves > 0 ? v.cpSum / v.moves : null
			});
		}
		vars.sort((a, b) => b.games - a.games);

		rows.push({
			opening: acc.family,
			color: acc.color,
			role,
			games: acc.games,
			wins: acc.wins,
			losses: acc.losses,
			draws: acc.draws,
			winRate,
			winRateDelta,
			avgCpLoss,
			cpLossDelta,
			byPhase,
			why,
			verdict,
			variations: vars.slice(0, 5)
		});
	}

	rows.sort((a, b) => compositeScore(b) - compositeScore(a));
	const best = rows.filter((r) => r.verdict === 'strong');
	const worst = rows.filter((r) => r.verdict === 'weak');
	const neutral = rows.filter((r) => r.verdict === 'neutral');

	return {
		rows,
		best,
		worst,
		neutral,
		userAvgCpLoss,
		userWinRate
	};
}

function tallyGame(
	acc: { games: number; wins: number; losses: number; draws: number },
	result: 'win' | 'loss' | 'draw'
) {
	acc.games += 1;
	if (result === 'win') acc.wins += 1;
	else if (result === 'loss') acc.losses += 1;
	else acc.draws += 1;
}

function phaseStats(moves: number, cpSum: number): OpeningPhaseStats {
	return { moves, avgCpLoss: moves > 0 ? cpSum / moves : 0 };
}

function verdictFor(wrDelta: number, cpDelta: number | null): OpeningVerdict {
	if (cpDelta != null) {
		if (wrDelta >= STRONG_WR && cpDelta <= STRONG_CP) return 'strong';
		if (wrDelta >= STRONG_WR * 1.5 && cpDelta <= 0) return 'strong';
		if (wrDelta <= WEAK_WR || cpDelta >= WEAK_CP) return 'weak';
		return 'neutral';
	}
	if (wrDelta >= STRONG_WR * 1.5) return 'strong';
	if (wrDelta <= WEAK_WR * 1.5) return 'weak';
	return 'neutral';
}

function compositeScore(r: OpeningProfileRow): number {
	const wr = r.winRateDelta * 2;
	const cp = r.cpLossDelta != null ? -r.cpLossDelta / 50 : 0;
	return wr + cp;
}

function buildWhy(
	verdict: OpeningVerdict,
	wrDelta: number,
	cpDelta: number | null,
	byPhase: Record<Phase, OpeningPhaseStats> | null,
	userCp: number | null
): string {
	const wrPp = Math.round(wrDelta * 100);
	const wrSign = wrPp >= 0 ? '+' : '';

	if (byPhase && userCp != null) {
		const gaps = (['opening', 'middle', 'end'] as const)
			.map((p) => ({ phase: p, gap: byPhase[p].avgCpLoss - userCp, moves: byPhase[p].moves }))
			.filter((g) => g.moves >= 10);

		if (verdict === 'strong') {
			const best = [...gaps].sort((a, b) => a.gap - b.gap)[0];
			if (best && best.gap <= -8) {
				return `${wrSign}${wrPp}pp vs your overall. ${phaseLabel(best.phase)} CP loss drops to ${Math.round(byPhase[best.phase].avgCpLoss)} (vs ${Math.round(userCp)} overall).`;
			}
			return `${wrSign}${wrPp}pp vs your overall. CP loss tracks your baseline — results over the board.`;
		}
		if (verdict === 'weak') {
			const worst = [...gaps].sort((a, b) => b.gap - a.gap)[0];
			if (worst && worst.gap >= 10) {
				const flavour =
					worst.phase === 'opening'
						? 'preparation gap'
						: worst.phase === 'middle'
							? 'middlegame plans misfire'
							: 'endgame technique';
				return `${wrSign}${wrPp}pp vs your overall. ${phaseLabel(worst.phase)} CP loss spikes to ${Math.round(byPhase[worst.phase].avgCpLoss)} (vs ${Math.round(userCp)} overall) — ${flavour}.`;
			}
			return `${wrSign}${wrPp}pp vs your overall. CP loss is ${Math.round(cpDelta ?? 0)} cp above baseline here.`;
		}
	}

	if (verdict === 'strong') return `${wrSign}${wrPp}pp vs your overall win rate.`;
	if (verdict === 'weak') return `${wrSign}${wrPp}pp vs your overall — negative outlier.`;
	return `${wrSign}${wrPp}pp vs your overall.`;
}

function phaseLabel(phase: Phase): string {
	return phase === 'opening' ? 'Opening' : phase === 'middle' ? 'Middlegame' : 'Endgame';
}

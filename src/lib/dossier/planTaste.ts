/**
 * Plan taste — where on the board you direct your pieces and pawns.
 * Derived from per-move destination files of every non-opening move.
 *
 * We split two things:
 *  - Piece aim: destination-file distribution of *piece* moves in the
 *    middlegame (reveals whether you maneuver to the flank you're
 *    attacking on).
 *  - Pawn storms: files where you pushed pawns past their 3rd rank in
 *    the middlegame (g/h-pawn pushes = kingside attack; a/b = minority).
 */

import type { ClassifiedGame } from './classify';

export type Wing = 'queenside' | 'center' | 'kingside';

export interface WingDistribution {
	queenside: number;
	center: number;
	kingside: number;
}

export interface PlanSummary {
	pieceAim: WingDistribution;
	pawnStorms: WingDistribution;
	/** Number of games with at least one g- or h-pawn advance past 3rd rank (user side). */
	kingsideStormGames: number;
	minorityAttackGames: number;
	totalGames: number;
	/** Mean number of user pawn-file pushes past 3rd rank per game. */
	avgPawnPushes: number;
	/** Dominant plan tag derived from the ratio of kingside:queenside piece-aim. */
	dominantPlan: 'kingside-pressure' | 'queenside-pressure' | 'central-play' | 'balanced';
}

export function analysePlanTaste(games: ClassifiedGame[]): PlanSummary {
	const pieceAim: WingDistribution = { queenside: 0, center: 0, kingside: 0 };
	const pawnStorms: WingDistribution = { queenside: 0, center: 0, kingside: 0 };
	let kingsideStormGames = 0;
	let minorityAttackGames = 0;
	let totalGames = 0;
	let totalPawnPushes = 0;

	for (const g of games) {
		if (g.moves.length === 0) continue;
		totalGames += 1;
		let gameKS = false;
		let gameQS = false;

		for (const m of g.moves) {
			if (m.phase === 'opening') continue;
			// Destination wing by file.
			const wing = fileWing(m.toFile);
			if (!m.isPawnMove && !m.isCastle) {
				pieceAim[wing] += 1;
			}

			// Pawn pushes past 3rd rank (user-side).
			if (m.isPawnMove && pawnPushedPastThird(m.fromRank, m.toRank, g.color)) {
				totalPawnPushes += 1;
				pawnStorms[wing] += 1;
				if (m.toFile >= 6) gameKS = true;
				if (m.toFile <= 1) gameQS = true;
			}
		}

		if (gameKS) kingsideStormGames += 1;
		if (gameQS) minorityAttackGames += 1;
	}

	const total = pieceAim.queenside + pieceAim.center + pieceAim.kingside;
	let dominantPlan: PlanSummary['dominantPlan'] = 'balanced';
	if (total > 0) {
		const qs = pieceAim.queenside / total;
		const ks = pieceAim.kingside / total;
		const ce = pieceAim.center / total;
		if (ks - qs > 0.08 && ks - ce > 0.05) dominantPlan = 'kingside-pressure';
		else if (qs - ks > 0.08 && qs - ce > 0.05) dominantPlan = 'queenside-pressure';
		else if (ce - qs > 0.08 && ce - ks > 0.08) dominantPlan = 'central-play';
	}

	return {
		pieceAim,
		pawnStorms,
		kingsideStormGames,
		minorityAttackGames,
		totalGames,
		avgPawnPushes: totalGames > 0 ? totalPawnPushes / totalGames : 0,
		dominantPlan
	};
}

function fileWing(file: number): Wing {
	if (file <= 2) return 'queenside';
	if (file >= 5) return 'kingside';
	return 'center';
}

function pawnPushedPastThird(fromRank: number, toRank: number, color: 'white' | 'black'): boolean {
	if (color === 'white') return toRank >= 4 && toRank > fromRank;
	return toRank <= 3 && toRank < fromRank;
}

export function wingShare(d: WingDistribution): WingDistribution {
	const total = d.queenside + d.center + d.kingside;
	if (total === 0) return { queenside: 0, center: 0, kingside: 0 };
	return {
		queenside: d.queenside / total,
		center: d.center / total,
		kingside: d.kingside / total
	};
}

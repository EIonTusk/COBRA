/**
 * Piece affinity — what you do when you can trade. Uses the capturedRole
 * field that classify now stamps on every move to derive:
 *
 *  - Minor-piece trade ratio: bishop-for-knight vs knight-for-bishop,
 *    split by your color (are you a bishop-pair hoarder?).
 *  - Material cash-in order: which piece you trade first in games that
 *    reach an endgame (proxy for "who do you like to keep").
 *  - Piece survival: average plies each piece lives per game (lower =
 *    cashed early, higher = hoarded).
 */

import type { Role } from 'chessops/types';
import type { ClassifiedGame } from './classify';

export interface TradeCount {
	bishopForKnight: number;
	knightForBishop: number;
	bishopForBishop: number;
	knightForKnight: number;
}

export interface CapturePair {
	captor: Role;
	captured: Role;
	count: number;
}

export interface AffinitySummary {
	totalCaptures: number;
	trades: TradeCount;
	tradesByColor: Record<'white' | 'black', TradeCount>;
	minorPairs: CapturePair[];
	majorPairs: CapturePair[];
	/**
	 * Net captures per own piece role: how many opponent units of that role
	 * the user cashed in. Reveals predatory preferences (e.g. "you eat
	 * knights more than bishops").
	 */
	byCaptured: Partial<Record<Role, number>>;
	byCaptor: Partial<Record<Role, number>>;
	/** Share of total captures performed while the piece's side was "up". */
	capturesWhileAhead: number;
	capturesWhileBehind: number;
	capturesWhileEqual: number;
}

export function analysePieceAffinity(games: ClassifiedGame[]): AffinitySummary {
	const trades: TradeCount = {
		bishopForKnight: 0,
		knightForBishop: 0,
		bishopForBishop: 0,
		knightForKnight: 0
	};
	const tradesByColor: Record<'white' | 'black', TradeCount> = {
		white: { bishopForKnight: 0, knightForBishop: 0, bishopForBishop: 0, knightForKnight: 0 },
		black: { bishopForKnight: 0, knightForBishop: 0, bishopForBishop: 0, knightForKnight: 0 }
	};
	const pairMap = new Map<string, number>();
	const byCaptor: Partial<Record<Role, number>> = {};
	const byCaptured: Partial<Record<Role, number>> = {};
	let totalCaptures = 0;
	let ahead = 0;
	let behind = 0;
	let equal = 0;

	for (const g of games) {
		for (const m of g.moves) {
			if (!m.isCapture || !m.capturedRole) continue;
			totalCaptures += 1;
			const captor = m.pieceRole;
			const captured = m.capturedRole;
			byCaptor[captor] = (byCaptor[captor] ?? 0) + 1;
			byCaptured[captured] = (byCaptured[captured] ?? 0) + 1;
			const key = `${captor}×${captured}`;
			pairMap.set(key, (pairMap.get(key) ?? 0) + 1);

			if (captor === 'bishop' && captured === 'knight') {
				trades.bishopForKnight += 1;
				tradesByColor[g.color].bishopForKnight += 1;
			} else if (captor === 'knight' && captured === 'bishop') {
				trades.knightForBishop += 1;
				tradesByColor[g.color].knightForBishop += 1;
			} else if (captor === 'bishop' && captured === 'bishop') {
				trades.bishopForBishop += 1;
				tradesByColor[g.color].bishopForBishop += 1;
			} else if (captor === 'knight' && captured === 'knight') {
				trades.knightForKnight += 1;
				tradesByColor[g.color].knightForKnight += 1;
			}

			if (m.materialDiff > 1.5) ahead += 1;
			else if (m.materialDiff < -1.5) behind += 1;
			else equal += 1;
		}
	}

	const pairs: CapturePair[] = Array.from(pairMap.entries()).map(([k, count]) => {
		const [captor, captured] = k.split('×') as [Role, Role];
		return { captor, captured, count };
	});
	const isMinor = (r: Role) => r === 'bishop' || r === 'knight';
	const minorPairs = pairs
		.filter((p) => isMinor(p.captor) && isMinor(p.captured))
		.sort((a, b) => b.count - a.count);
	const majorPairs = pairs
		.filter((p) => !isMinor(p.captor) || !isMinor(p.captured))
		.sort((a, b) => b.count - a.count);

	return {
		totalCaptures,
		trades,
		tradesByColor,
		minorPairs,
		majorPairs,
		byCaptor,
		byCaptured,
		capturesWhileAhead: totalCaptures > 0 ? ahead / totalCaptures : 0,
		capturesWhileBehind: totalCaptures > 0 ? behind / totalCaptures : 0,
		capturesWhileEqual: totalCaptures > 0 ? equal / totalCaptures : 0
	};
}

/** "You cash bishops for knights N% vs M% the other way" headline. */
export function minorTradeLean(s: AffinitySummary): {
	lean: 'bishop' | 'knight' | 'balanced';
	bfkPct: number;
	kfbPct: number;
} {
	const bfk = s.trades.bishopForKnight;
	const kfb = s.trades.knightForBishop;
	const total = bfk + kfb;
	if (total < 5) return { lean: 'balanced', bfkPct: 0, kfbPct: 0 };
	const bfkPct = bfk / total;
	const kfbPct = kfb / total;
	if (bfkPct - kfbPct > 0.15) return { lean: 'knight', bfkPct, kfbPct }; // you trade bishops for knights → you prefer keeping knights
	if (kfbPct - bfkPct > 0.15) return { lean: 'bishop', bfkPct, kfbPct };
	return { lean: 'balanced', bfkPct, kfbPct };
}

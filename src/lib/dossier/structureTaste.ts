/**
 * Structure Taste — how often your games pass through recognisable
 * middlegame pawn structures, and how you score in each. Takes a snapshot
 * at the first middlegame move of each game and classifies the pawn
 * skeleton with cheap heuristics.
 */

import { parseFen } from 'chessops/fen';
import { setupPosition } from 'chessops/variant';
import { SquareSet } from 'chessops/squareSet';
import type { Position } from 'chessops/chess';
import type { Color } from 'chessops/types';

import type { ClassifiedGame } from './classify';

export type Structure =
	| 'iqp-white'
	| 'iqp-black'
	| 'closed-center'
	| 'open-center'
	| 'fixed-center'
	| 'hanging-pawns'
	| 'pawn-chain'
	| 'heavy-majority'
	| 'symmetric';

export interface StructureBucket {
	key: Structure;
	games: number;
	wins: number;
	losses: number;
	draws: number;
	winRate: number;
}

export interface StructureSummary {
	totalGames: number;
	byStructure: StructureBucket[];
	openFileAverage: number;
	avgPawnIslandsUser: number;
	avgPawnIslandsOpp: number;
	/** Win-rate delta: how much your win rate changes in *chosen* structures vs overall. */
	overallWinRate: number;
}

const LABELS: Record<Structure, string> = {
	'iqp-white': 'IQP on d4 (you White)',
	'iqp-black': 'IQP on d5 (you Black)',
	'closed-center': 'Closed center',
	'open-center': 'Open center',
	'fixed-center': 'Fixed center',
	'hanging-pawns': 'Hanging pawns',
	'pawn-chain': 'Locked pawn chain',
	'heavy-majority': 'Wing majority',
	symmetric: 'Symmetric pawn skeleton'
};

export function structureLabel(k: Structure): string {
	return LABELS[k];
}

export function analyseStructureTaste(games: ClassifiedGame[]): StructureSummary {
	const counts = new Map<
		Structure,
		{ wins: number; losses: number; draws: number; games: number }
	>();
	let totalGames = 0;
	let openFileSum = 0;
	let islandSumUser = 0;
	let islandSumOpp = 0;
	let samples = 0;
	let winsOverall = 0;

	for (const g of games) {
		const firstMid = g.moves.find((m) => m.phase === 'middle');
		if (!firstMid) continue;
		const fen = firstMid.fenBefore;
		const pos = fenToPos(fen);
		if (!pos) continue;
		totalGames += 1;
		samples += 1;
		if (g.result === 'win') winsOverall += 1;

		const structs = classifyStructure(pos, g.color);
		for (const s of structs) {
			const b = counts.get(s) ?? { wins: 0, losses: 0, draws: 0, games: 0 };
			b.games += 1;
			if (g.result === 'win') b.wins += 1;
			else if (g.result === 'loss') b.losses += 1;
			else b.draws += 1;
			counts.set(s, b);
		}

		openFileSum += countOpenFiles(pos);
		islandSumUser += countPawnIslands(pos, g.color);
		islandSumOpp += countPawnIslands(pos, g.color === 'white' ? 'black' : 'white');
	}

	const byStructure: StructureBucket[] = Array.from(counts.entries())
		.map(([key, b]) => ({
			key,
			...b,
			winRate: b.games > 0 ? b.wins / b.games : 0
		}))
		.sort((a, b) => b.games - a.games);

	const overallWinRate = totalGames > 0 ? winsOverall / totalGames : 0;

	return {
		totalGames,
		byStructure,
		openFileAverage: samples > 0 ? openFileSum / samples : 0,
		avgPawnIslandsUser: samples > 0 ? islandSumUser / samples : 0,
		avgPawnIslandsOpp: samples > 0 ? islandSumOpp / samples : 0,
		overallWinRate
	};
}

function fenToPos(fen: string): Position | null {
	const setup = parseFen(fen);
	if (setup.isErr) return null;
	const posR = setupPosition('chess', setup.value);
	if (posR.isErr) return null;
	return posR.value;
}

function pawnsOfColor(pos: Position, color: Color): SquareSet {
	return pos.board.pawn.intersect(color === 'white' ? pos.board.white : pos.board.black);
}

function pawnsByFile(pawns: SquareSet): number[] {
	const counts = new Array(8).fill(0);
	for (const sq of pawns) counts[sq & 7] += 1;
	return counts;
}

function classifyStructure(pos: Position, userColor: Color): Structure[] {
	const tags: Structure[] = [];
	const wp = pawnsOfColor(pos, 'white');
	const bp = pawnsOfColor(pos, 'black');
	const wf = pawnsByFile(wp);
	const bf = pawnsByFile(bp);

	// IQP: a pawn on d-file, no pawns on c or e for same color.
	if (wf[3] >= 1 && wf[2] === 0 && wf[4] === 0) tags.push('iqp-white');
	if (bf[3] >= 1 && bf[2] === 0 && bf[4] === 0) tags.push('iqp-black');

	// Hanging pawns: same color has c+d or d+e pair with neither flanking support.
	for (const arr of [wf, bf]) {
		if (arr[2] >= 1 && arr[3] >= 1 && arr[1] === 0 && arr[4] === 0) tags.push('hanging-pawns');
		if (arr[3] >= 1 && arr[4] >= 1 && arr[2] === 0 && arr[5] === 0) tags.push('hanging-pawns');
	}

	// Closed center: locked d/e pawns on adjacent ranks with same files occupied.
	const lockedD = isLockedPair(pos, 3);
	const lockedE = isLockedPair(pos, 4);
	if (lockedD && lockedE) tags.push('closed-center');
	else if (wf[3] + wf[4] + bf[3] + bf[4] === 0) tags.push('open-center');
	else if (lockedD || lockedE) tags.push('fixed-center');

	// Locked pawn chain: at least 3 user pawns in a diagonal contact chain.
	if (hasPawnChain(pos, userColor)) tags.push('pawn-chain');

	// Heavy wing majority: user has ≥2 more pawns on one wing than opponent.
	const userArr = userColor === 'white' ? wf : bf;
	const oppArr = userColor === 'white' ? bf : wf;
	const userQ = userArr[0] + userArr[1] + userArr[2] + userArr[3];
	const userK = userArr[4] + userArr[5] + userArr[6] + userArr[7];
	const oppQ = oppArr[0] + oppArr[1] + oppArr[2] + oppArr[3];
	const oppK = oppArr[4] + oppArr[5] + oppArr[6] + oppArr[7];
	if (Math.abs(userQ - oppQ) >= 2 || Math.abs(userK - oppK) >= 2) tags.push('heavy-majority');

	// Symmetric: each file has equal pawn counts for both sides.
	let symmetric = true;
	for (let f = 0; f < 8; f += 1) {
		if (wf[f] !== bf[f]) {
			symmetric = false;
			break;
		}
	}
	if (symmetric) tags.push('symmetric');

	return tags;
}

function isLockedPair(pos: Position, file: number): boolean {
	const wp = pawnsOfColor(pos, 'white');
	const bp = pawnsOfColor(pos, 'black');
	for (let rank = 1; rank <= 6; rank += 1) {
		const sq = rank * 8 + file;
		if (wp.has(sq) && bp.has(sq + 8)) return true;
	}
	return false;
}

function hasPawnChain(pos: Position, color: Color): boolean {
	const pawns = pawnsOfColor(pos, color);
	const dir = color === 'white' ? 1 : -1;
	let best = 0;
	for (const sq of pawns) {
		let len = 1;
		let cur = sq;
		while (true) {
			const file = cur & 7;
			const rank = cur >> 3;
			const nextRank = rank + dir;
			if (nextRank < 0 || nextRank > 7) break;
			const rightNext = nextRank * 8 + (file + 1);
			const leftNext = nextRank * 8 + (file - 1);
			if (file + 1 <= 7 && pawns.has(rightNext)) {
				cur = rightNext;
				len += 1;
				continue;
			}
			if (file - 1 >= 0 && pawns.has(leftNext)) {
				cur = leftNext;
				len += 1;
				continue;
			}
			break;
		}
		if (len > best) best = len;
	}
	return best >= 3;
}

function countOpenFiles(pos: Position): number {
	const wp = pawnsOfColor(pos, 'white');
	const bp = pawnsOfColor(pos, 'black');
	const wf = pawnsByFile(wp);
	const bf = pawnsByFile(bp);
	let open = 0;
	for (let f = 0; f < 8; f += 1) {
		if (wf[f] === 0 && bf[f] === 0) open += 1;
	}
	return open;
}

function countPawnIslands(pos: Position, color: Color): number {
	const files = pawnsByFile(pawnsOfColor(pos, color));
	let islands = 0;
	let inRun = false;
	for (let f = 0; f < 8; f += 1) {
		if (files[f] > 0 && !inRun) {
			islands += 1;
			inRun = true;
		} else if (files[f] === 0) {
			inRun = false;
		}
	}
	return islands;
}

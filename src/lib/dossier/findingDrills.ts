/**
 * Bridge from style findings to the Mistakes drill pipeline. Mirrors
 * `leakDrills.ts`, but for two other finding sources:
 *
 *  - Tactical motifs: each blunder move instance carries a fenBefore and
 *    a played SAN + a motif label we stash in expectedSan as a hint.
 *  - Repeat offenders: we persist each exampleFen with a motif-derived
 *    prompt so the drill page tells the user what theme to spot.
 *
 * Composite id prefix `motif:` / `repeat:` keeps them separate from
 * out-of-tree mistakes and leak drills.
 */
import { tryFenKey } from '$lib/chess/fen';
import type { Repertoire, StoredMistake } from '$lib/types';
import type { MotifInstance, Motif } from './tacticalMotifs';
import { motifLabel } from './tacticalMotifs';
import type { OffenderRow } from './repeatOffenders';
import { offenderHeading } from './repeatOffenders';

const MOTIF_PREFIX = 'motif';
const REPEAT_PREFIX = 'repeat';

export function motifInstanceToStoredMistake(
	inst: MotifInstance,
	motif: Motif,
	rep: Pick<Repertoire, 'id' | 'name'>,
	color: 'white' | 'black' = 'white'
): StoredMistake | null {
	const fenKey = tryFenKey(inst.fenBefore);
	if (!fenKey) return null;
	return {
		id: `${MOTIF_PREFIX}:${motif}:${inst.gameId}:${rep.id}:${fenKey}`,
		gameId: inst.gameId,
		gameUrl: gameUrlFromId(inst.gameId),
		playedAt: inst.playedAt,
		detectedAt: Date.now(),
		speed: 'unknown',
		opponent: '',
		color,
		repertoireId: rep.id,
		repertoireName: rep.name,
		fenKey,
		fen: inst.fenBefore,
		playedSan: inst.san,
		expectedSan: `(missed ${motifLabel(motif).toLowerCase()})`,
		plyOffTree: inst.ply,
		status: 'pending',
		correctCount: 0
	};
}

export function repeatFenToStoredMistake(
	row: OffenderRow,
	fen: string,
	idx: number,
	rep: Pick<Repertoire, 'id' | 'name'>
): StoredMistake | null {
	const fenKey = tryFenKey(fen);
	if (!fenKey) return null;
	const motif = row.motif;
	return {
		id: `${REPEAT_PREFIX}:${motif}:${row.pieceInvolved}:${idx}:${rep.id}:${fenKey}`,
		gameId: `repeat-${motif}-${idx}`,
		gameUrl: '',
		playedAt: Date.now(),
		detectedAt: Date.now(),
		speed: 'unknown',
		opponent: '',
		color: 'white',
		repertoireId: rep.id,
		repertoireName: rep.name,
		fenKey,
		fen,
		playedSan: '',
		expectedSan: `(recurring: ${offenderHeading(row).toLowerCase()})`,
		plyOffTree: 0,
		status: 'pending',
		correctCount: 0
	};
}

function gameUrlFromId(gameId: string): string {
	if (gameId.startsWith('cc-')) {
		const numeric = gameId.slice(3);
		return `https://www.chess.com/game/live/${numeric}`;
	}
	return `https://lichess.org/${gameId}`;
}

/**
 * Bridge from style-leaks to the existing Mistakes drill pipeline. A
 * `LeakInstance` carries a FEN, a played SAN, and a leak type — enough to
 * persist as a `StoredMistake` row that shows up in `/mistakes` alongside
 * the user's regular out-of-tree blunders.
 *
 * Style leaks aren't tied to a repertoire intrinsically (they're general
 * decision-quality flags), so the user picks which repertoire to attribute
 * them to. Dedup by composite id (gameId + repertoireId + fenKey) is
 * inherited from the existing mistake store.
 */

import { tryFenKey } from '$lib/chess/fen';
import type { Repertoire, StoredMistake } from '$lib/types';
import type { LeakInstance, LeakType } from './mismatch';

const LEAK_HINT: Record<LeakType, string> = {
	missed_capture: '(capture available)',
	missed_attack: '(king is exposed)',
	impatient_forcing: '(quiet move)'
};

const SOURCE_PREFIX = 'leak';

/**
 * Build a StoredMistake for a leak. Returns null if the leak FEN is
 * unparseable (shouldn't happen in practice — classify wouldn't have
 * produced it). Composite id is prefixed with `leak:` so it never collides
 * with a real out-of-tree mistake at the same fenKey.
 */
export function leakToStoredMistake(
	leak: LeakInstance,
	rep: Pick<Repertoire, 'id' | 'name'>
): StoredMistake | null {
	const fenKey = tryFenKey(leak.fenBefore);
	if (!fenKey) return null;
	return {
		id: `${SOURCE_PREFIX}:${leak.gameId}:${rep.id}:${fenKey}`,
		gameId: leak.gameId,
		gameUrl: gameUrlFromId(leak.gameId),
		playedAt: leak.playedAt,
		detectedAt: Date.now(),
		speed: 'unknown',
		opponent: '',
		color: leak.color,
		repertoireId: rep.id,
		repertoireName: rep.name,
		fenKey,
		fen: leak.fenBefore,
		playedSan: leak.san,
		expectedSan: LEAK_HINT[leak.type],
		plyOffTree: leak.ply,
		status: 'pending',
		correctCount: 0
	};
}

/**
 * Lichess game ids are bare 8-char strings; chess.com ids are prefixed
 * with `cc-`. Reconstruct a viewer URL we can stash on the StoredMistake.
 */
function gameUrlFromId(gameId: string): string {
	if (gameId.startsWith('cc-')) {
		const numeric = gameId.slice(3);
		return `https://www.chess.com/game/live/${numeric}`;
	}
	return `https://lichess.org/${gameId}`;
}

/**
 * Repertoire lint — cross-reference the dossier's observed leaks against
 * the user's own stored repertoires. Any blunder whose FEN-before sits
 * in a repertoire tree with a *prepared* reply that differs from what
 * the user actually played is "forgotten prep" — a fix with unusually
 * high leverage because the work was already done once.
 *
 * This is one of the few cards whose data lives entirely in-app. The
 * dossier normally reads only games + evals; here we reach into the
 * repertoire store (IndexedDB `nodes`/`repertoires`) and join on FEN.
 *
 * The join is exact on FEN-key (same canonical form repertoires use for
 * node identity). Transpositions resolve automatically — the builder
 * already de-duplicates FEN-keyed positions across move orders.
 */

import type { EvalMoveResult } from './evalAxes';
import type { Repertoire, RepertoireNode, Color } from '$lib/types';
import { fenKeyFromFen } from '$lib/chess/fen';

export interface ForgottenPrepEntry {
	gameId: string;
	ply: number;
	phase: EvalMoveResult['phase'];
	fenBefore: string;
	userPlayedSan: string;
	preparedSan: string;
	/** Which repertoire contains the prepared reply. */
	repertoireId: string;
	repertoireName: string;
	color: Color;
	cpLoss: number;
	wpLoss: number;
	classification: EvalMoveResult['classification'];
}

export interface RepertoireLintSummary {
	entries: ForgottenPrepEntry[];
	/** How many user blunders/mistakes cross-referenced (denominator). */
	checked: number;
	/** How many positions were actually in a repertoire tree (FEN-match). */
	inRepertoire: number;
	/** How many matched AND the user deviated from their prep. */
	deviated: number;
}

/**
 * Build a lint summary given the user's eval moves and their stored
 * repertoires with node lists. The caller is responsible for fetching
 * repertoires + nodes from IDB — this module is pure, so it can be
 * unit-tested without storage.
 */
export function buildRepertoireLint(
	moves: EvalMoveResult[] | null | undefined,
	repertoires: Array<{ repertoire: Repertoire; nodes: RepertoireNode[] }>
): RepertoireLintSummary {
	if (!moves || moves.length === 0 || repertoires.length === 0) {
		return { entries: [], checked: 0, inRepertoire: 0, deviated: 0 };
	}

	// Build a per-colour FEN → (prepared move, repertoire) index. A FEN
	// may appear in multiple repertoires of the same colour; we keep all
	// and surface the first match for display (the subpage can show all).
	type Prepared = {
		san: string;
		repertoireId: string;
		repertoireName: string;
		color: Color;
	};
	const byFen = new Map<string, Prepared[]>();
	for (const { repertoire, nodes } of repertoires) {
		for (const n of nodes) {
			for (const edge of n.children) {
				const entry: Prepared = {
					san: edge.san,
					repertoireId: repertoire.id,
					repertoireName: repertoire.name,
					color: repertoire.color
				};
				const arr = byFen.get(n.fenKey) ?? [];
				arr.push(entry);
				byFen.set(n.fenKey, arr);
			}
		}
	}

	const entries: ForgottenPrepEntry[] = [];
	let checked = 0;
	let inRepertoire = 0;
	let deviated = 0;

	for (const m of moves) {
		// Only look at moves that actually cost something: blunders,
		// mistakes, and significant inaccuracies. "Forgot my prep but
		// played the best move anyway" isn't a finding.
		if (m.classification === 'best' || m.classification === 'inaccuracy') continue;
		checked += 1;

		let fenKey: string;
		try {
			fenKey = fenKeyFromFen(m.fenBefore);
		} catch {
			continue; // malformed FEN — skip silently.
		}
		const prepared = byFen.get(fenKey);
		if (!prepared || prepared.length === 0) continue;
		inRepertoire += 1;

		// Match colour: only a reply in the same-colour repertoire counts
		// as prep. If the user's game is as white, we look for white
		// repertoires where this exact position has a prepared reply.
		const sameColour = prepared.filter((p) => p.color === m.userColor);
		if (sameColour.length === 0) continue;

		// Deviation: user's SAN differs from *every* prepared reply in the
		// tree. If any prepared reply matches, the user played prep (so
		// the blunder came from a different source — their prep was wrong).
		const userSan = m.san;
		const match = sameColour.find((p) => p.san === userSan);
		if (match) continue; // matches prep — not a forgotten-prep leak
		deviated += 1;

		// Take the first prepared reply for display. If the tree branches
		// (multiple prepared children), the subpage can render all of them.
		const pick = sameColour[0];
		entries.push({
			gameId: m.gameId,
			ply: m.ply,
			phase: m.phase,
			fenBefore: m.fenBefore,
			userPlayedSan: userSan,
			preparedSan: pick.san,
			repertoireId: pick.repertoireId,
			repertoireName: pick.repertoireName,
			color: pick.color,
			cpLoss: m.cpLoss,
			wpLoss: m.wpLoss,
			classification: m.classification
		});
	}

	// Sort by WP loss descending so the most-costly forgotten lines lead.
	entries.sort((a, b) => b.wpLoss - a.wpLoss);

	return { entries, checked, inRepertoire, deviated };
}

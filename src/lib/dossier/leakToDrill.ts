/**
 * Pattern-to-drill synthesis. Materialise StoredMistake entries directly
 * from the dossier's identified leaks so the existing retrain flow can
 * pick them up without the user having to copy-paste anything.
 *
 * COBRA's existing mistake scanner (src/lib/lichess/mistakeScan.ts)
 * writes StoredMistake rows whenever a scanned game deviates from a
 * repertoire tree's prepared reply. The dossier already computes richer
 * leak categorisations — blunder atlas, repeat offenders, repertoire
 * lint. This module bridges them: each leak becomes a retrainable drill
 * card with the same shape, so the `?mode=retrain` drill session seeds
 * directly from dossier output.
 *
 * Pure function: takes the leak context + repertoire names, returns
 * StoredMistake[]. Caller persists via saveMistakes().
 */

import type { EvalMoveResult } from './evalAxes';
import type { StoredMistake, Repertoire } from '$lib/types';
import type { ForgottenPrepEntry } from './repertoireLint';
import { fenKeyFromFen } from '$lib/chess/fen';

export interface LeakToDrillOpts {
	/** Max drills to create. Default 25 — more than a user will realistically clear per week. */
	limit?: number;
	/** Opponent label for the synthesised mistake record. */
	opponent?: string;
}

/**
 * Build StoredMistake rows from blunder-atlas-style leaks — worst user
 * moves identified during the scan. Because the user has multiple
 * repertoires and the leaks aren't directly tied to any one, we anchor
 * each drill to the *most-used* repertoire for that colour.
 *
 * If the user has no repertoire for the move's colour, the drill is
 * skipped — there's nothing for the retrain session to drill *against*.
 */
export function buildDrillsFromLeaks(
	leaks: EvalMoveResult[],
	repertoires: Repertoire[],
	opts: LeakToDrillOpts = {}
): StoredMistake[] {
	const limit = opts.limit ?? 25;
	const byColour = new Map<'white' | 'black', Repertoire>();
	for (const r of repertoires) {
		// Prefer the most recently updated repertoire of each colour.
		const existing = byColour.get(r.color);
		if (!existing || (r.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
			byColour.set(r.color, r);
		}
	}

	const out: StoredMistake[] = [];
	const seen = new Set<string>();
	// Rank by WP loss descending — the highest-impact leaks first.
	const ranked = [...leaks].sort((a, b) => b.wpLoss - a.wpLoss);
	for (const m of ranked) {
		if (out.length >= limit) break;
		const rep = byColour.get(m.userColor);
		if (!rep) continue;
		let fenKey: string;
		try {
			fenKey = fenKeyFromFen(m.fenBefore);
		} catch {
			continue;
		}
		const id = `${m.gameId}:${rep.id}:${fenKey}`;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push({
			id,
			gameId: m.gameId,
			gameUrl: '', // scan-derived record; original URL isn't carried on EvalMoveResult.
			playedAt: m.playedAt,
			detectedAt: Date.now(),
			speed: 'unknown',
			opponent: opts.opponent ?? 'self',
			color: m.userColor,
			repertoireId: rep.id,
			repertoireName: rep.name,
			fenKey,
			fen: m.fenBefore,
			playedSan: m.san,
			expectedSan: m.bestUci ?? '?',
			plyOffTree: 0,
			status: 'pending',
			correctCount: 0
		});
	}
	return out;
}

/**
 * Forgotten-prep drills: every entry the repertoire-lint module surfaced
 * already carries the prepared move *and* the specific repertoire it
 * belongs to. Materialising those is trivial and high-signal — it's the
 * literal definition of a retrain candidate ("you forgot your prep at
 * this exact FEN"). These get priority over raw leak-based drills when
 * both sources flag the same position.
 */
export function buildDrillsFromForgottenPrep(
	entries: ForgottenPrepEntry[],
	opts: LeakToDrillOpts = {}
): StoredMistake[] {
	const limit = opts.limit ?? 25;
	const out: StoredMistake[] = [];
	const seen = new Set<string>();
	for (const e of entries) {
		if (out.length >= limit) break;
		let fenKey: string;
		try {
			fenKey = fenKeyFromFen(e.fenBefore);
		} catch {
			continue;
		}
		const id = `${e.gameId}:${e.repertoireId}:${fenKey}`;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push({
			id,
			gameId: e.gameId,
			gameUrl: '',
			playedAt: 0,
			detectedAt: Date.now(),
			speed: 'unknown',
			opponent: opts.opponent ?? 'self',
			color: e.color,
			repertoireId: e.repertoireId,
			repertoireName: e.repertoireName,
			fenKey,
			fen: e.fenBefore,
			playedSan: e.userPlayedSan,
			expectedSan: e.preparedSan,
			plyOffTree: 0,
			status: 'pending',
			correctCount: 0
		});
	}
	return out;
}

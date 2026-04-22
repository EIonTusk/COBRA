/**
 * FSRS retention feedback.
 *
 * The drill system already records how often each flashcard has been
 * failed (`lapses`). Repeated failures on the same card are a different
 * kind of leak from in-game blunders — they measure *knowledge
 * retention*, not in-game decision quality. Surfacing them closes a loop
 * the dossier has historically ignored: positions the user struggles to
 * *learn* even when isolated from real-game pressure.
 *
 * Pure function — the caller fetches cards from IDB and passes in the
 * rows. That keeps this testable without storage.
 */

import type { Card, Repertoire } from '$lib/types';

export interface FsrsFailureRow {
	repertoireId: string;
	repertoireName: string;
	fenKey: string;
	expectedSan: string;
	lapses: number;
}

/**
 * Minimum lapse count below which a card is not considered a retention
 * leak. 3 is empirical: two lapses can plausibly be concentration
 * accidents on first encounter; three means the schedule has cycled the
 * card back multiple times and the user keeps flunking it.
 */
export const LAPSE_THRESHOLD = 3;

export interface BuildOpts {
	/** Override lapse threshold (e.g. for tests or tighter surfaces). */
	lapseThreshold?: number;
	/** Cap on rows returned. Default 20 so the card isn't a wall of text. */
	limit?: number;
}

/**
 * Build the failure-row list from (cards, repertoires). `cards` is the
 * flat IDB contents of the `cards` store. `repertoires` supplies names
 * keyed by id so rows render with human-readable labels.
 */
export function buildFsrsFailures(
	cards: Card[],
	repertoires: Repertoire[],
	opts: BuildOpts = {}
): FsrsFailureRow[] {
	const threshold = opts.lapseThreshold ?? LAPSE_THRESHOLD;
	const limit = opts.limit ?? 20;

	const nameById = new Map(repertoires.map((r) => [r.id, r.name]));

	const rows: FsrsFailureRow[] = [];
	for (const c of cards) {
		const lapses = c.fsrs?.lapses ?? 0;
		if (lapses < threshold) continue;
		rows.push({
			repertoireId: c.repertoireId,
			repertoireName: nameById.get(c.repertoireId) ?? '(deleted)',
			fenKey: c.fenKey,
			expectedSan: c.expectedSan,
			lapses
		});
	}

	rows.sort((a, b) => b.lapses - a.lapses);
	return rows.slice(0, limit);
}

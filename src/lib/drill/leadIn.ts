import type { Edge, RepertoireNode } from '$lib/types';

/**
 * How the board gets to a drill card's position (its "lead-in").
 *
 * The lead-in is planned from where the board *is*, not from whether the
 * card was seen earlier in the session: only the board tells us whether
 * the user can follow the jump to the new position.
 *
 * - `stay`: the board already shows the card's position (a line walk
 *   chaining into its next step).
 * - `tail`: the board shows a position on the way to the card; play the
 *   remaining moves from `path[from]` on.
 * - `rewind`: the board is at most {@link MAX_REWIND_PLIES} past the card
 *   on the same line (the card is asked again right after it was
 *   answered); step back to it, which reads as a takeback.
 * - `full`: anything else. Play the line from the start, subject to the
 *   "open at starting position" preference.
 */
export type LeadIn =
	| { kind: 'stay' }
	| { kind: 'tail'; from: number }
	| { kind: 'rewind' }
	| { kind: 'full' };

/** The user's answer plus the opponent's reply. */
export const MAX_REWIND_PLIES = 2;

/**
 * @param path    moves from the repertoire root to the card's position
 * @param rootKey the repertoire root's fenKey
 * @param target  the card's fenKey
 * @param current the fenKey the board shows now, or null when it shows nothing yet
 */
export function planLeadIn(
	nodes: Map<string, RepertoireNode>,
	path: Edge[],
	rootKey: string,
	target: string,
	current: string | null
): LeadIn {
	if (current === null) return { kind: 'full' };
	if (current === target) return { kind: 'stay' };
	// From the root a full lead-in and a tail are the same moves; `full`
	// keeps the starting-position preference in play.
	if (current !== rootKey) {
		const at = path.findIndex((e) => e.toFenKey === current);
		if (at >= 0) return { kind: 'tail', from: at + 1 };
	}
	if (isShortlyAfter(nodes, target, current, MAX_REWIND_PLIES)) return { kind: 'rewind' };
	return { kind: 'full' };
}

/** Whether `current` is reached from `target` in 1..`plies` moves. */
function isShortlyAfter(
	nodes: Map<string, RepertoireNode>,
	target: string,
	current: string,
	plies: number
): boolean {
	let frontier = [target];
	for (let d = 0; d < plies; d++) {
		const next: string[] = [];
		for (const key of frontier) {
			for (const e of nodes.get(key)?.children ?? []) {
				if (e.toFenKey === current) return true;
				next.push(e.toFenKey);
			}
		}
		frontier = next;
	}
	return false;
}

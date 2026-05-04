/**
 * Per-repertoire opening fit. Sister module to `openingProfile.ts`: the
 * latter buckets games by (PGN family × color); this one buckets by
 * (user's repertoire × color) by joining each game's user-side
 * `fenBefore` positions against the repertoire's stored node tree.
 *
 * Why bother with this when the family view already exists? Because the
 * family view answers "what openings show up?" while a player wants to
 * answer "how do I score in the lines I actually prepared?". Two reps
 * for the same colour (a 1.d4 main-line and a 1.b3 surprise weapon)
 * collapse into the same family rows, but their performance profiles
 * are entirely different.
 *
 * Attribution rule: a game is attributed to the same-colour repertoire
 * with the most matched non-root prep positions. A match means the
 * user's `fenBefore` (canonicalised to EPD) appears as a node in the
 * repertoire — i.e. the user reached a position they had prepped a
 * reply for. The root is excluded because every same-colour rep has
 * the starting position as its root, so a root-only match is no signal.
 *
 * Games with zero non-root matches against any rep go into the
 * `unattributed` bucket — the user played an opening they hadn't
 * prepped, or didn't have a rep on that side at all.
 */
import { fenKeyFromFen } from '$lib/chess/fen';
import { buildOpeningProfile, type OpeningProfileReport } from './openingProfile';
import type { ClassifiedGame } from './classify';
import type { EvalMoveResult } from './evalAxes';
import type { Repertoire, RepertoireNode } from '$lib/types';

export interface RepertoireProfileBucket {
	repertoire: Repertoire;
	games: ClassifiedGame[];
	/** Per-(family, color) rows for the games attributed to this rep. */
	profile: OpeningProfileReport;
}

export interface OpeningProfileByRepertoireReport {
	buckets: RepertoireProfileBucket[];
	unattributed: ClassifiedGame[];
	unattributedProfile: OpeningProfileReport;
	/** Total games considered (sum across buckets + unattributed = classified.length). */
	totalGames: number;
}

export function buildOpeningProfileByRepertoire(
	classified: ClassifiedGame[],
	moves: EvalMoveResult[] | null,
	repertoires: Array<{ repertoire: Repertoire; nodes: RepertoireNode[] }>
): OpeningProfileByRepertoireReport {
	// Pre-compute per-rep node fenKey set (excluding root).
	const repIndexes = repertoires.map(({ repertoire, nodes }) => {
		const set = new Set<string>();
		for (const n of nodes) {
			if (n.fenKey === repertoire.rootFenKey) continue;
			set.add(n.fenKey);
		}
		return { repertoire, set };
	});

	const bucketGames: ClassifiedGame[][] = repertoires.map(() => []);
	const unattributed: ClassifiedGame[] = [];

	for (const game of classified) {
		// Canonicalise each user-side `fenBefore` to a fenKey. Skip
		// malformed entries silently — the rest of the game still counts.
		const gameKeys = new Set<string>();
		for (const m of game.moves) {
			try {
				gameKeys.add(fenKeyFromFen(m.fenBefore));
			} catch {
				// malformed FEN — skip this position
			}
		}

		let bestIdx = -1;
		let bestCount = 0;
		for (let i = 0; i < repIndexes.length; i += 1) {
			const { repertoire, set } = repIndexes[i];
			if (repertoire.color !== game.color) continue;
			let count = 0;
			for (const k of gameKeys) {
				if (set.has(k)) count += 1;
			}
			if (count > bestCount) {
				bestCount = count;
				bestIdx = i;
			}
		}

		if (bestIdx >= 0 && bestCount >= 1) {
			bucketGames[bestIdx].push(game);
		} else {
			unattributed.push(game);
		}
	}

	const movesForGames = (gs: ClassifiedGame[]): EvalMoveResult[] | null => {
		if (!moves) return null;
		const ids = new Set(gs.map((g) => g.gameId));
		return moves.filter((m) => ids.has(m.gameId));
	};

	const buckets: RepertoireProfileBucket[] = repertoires.map(({ repertoire }, i) => ({
		repertoire,
		games: bucketGames[i],
		profile: buildOpeningProfile(bucketGames[i], movesForGames(bucketGames[i]))
	}));

	return {
		buckets,
		unattributed,
		unattributedProfile: buildOpeningProfile(unattributed, movesForGames(unattributed)),
		totalGames: classified.length
	};
}

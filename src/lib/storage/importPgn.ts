import { addEdge, applyImportedNote } from './nodes';
import { getCard, upsertCard } from './cards';
import { createFreshCard } from '$lib/fsrs/scheduler';
import { colorToMove } from '$lib/chess/fen';
import type { ParsedLine } from '$lib/chess/pgn';
import type { Color } from '$lib/types';

export interface MergeLinesResult {
	/** Lines whose starting position matched `rootFenKey` and were merged in. */
	importedLines: number;
	/**
	 * Lines skipped because they start from a different position than the
	 * repertoire's root — merging them would graft a subgraph that's
	 * unreachable from the root and never drilled.
	 */
	skippedLines: number;
	/** Moves newly added to the tree (edges that weren't already present). */
	addedEdges: number;
	/** Fresh FSRS move cards seeded for to-move positions that lacked one. */
	addedCards: number;
}

/**
 * Additively merge parsed PGN lines into an EXISTING repertoire's tree.
 *
 * Only lines whose `rootFenKey` matches the repertoire's own root are
 * merged; lines beginning from a different position are skipped and
 * counted (see `MergeLinesResult.skippedLines`).
 *
 * This uses the additive `addEdge` / `applyImportedNote` primitives, NOT
 * the destructive `replaceRepertoireTree`: existing moves dedupe by FEN
 * and existing FSRS history is preserved — a fresh card is only seeded for
 * a to-move position that has no card yet. Safe to call repeatedly with
 * overlapping PGNs.
 *
 * Shared by the new-repertoire `/import`, the Lichess study pull
 * (`/import-study`), and the in-repertoire `repertoire/[id]/import` flow so
 * all three agree on how PGN becomes tree.
 */
export async function mergeLinesIntoRepertoire(
	repertoireId: string,
	color: Color,
	rootFenKey: string,
	lines: ParsedLine[]
): Promise<MergeLinesResult> {
	const matching = lines.filter((l) => l.rootFenKey === rootFenKey);
	let addedEdges = 0;
	let addedCards = 0;
	for (const line of matching) {
		for (const { fromFenKey, edge, comment, nags } of line.edges) {
			const { created } = await addEdge(repertoireId, fromFenKey, edge);
			if (created) addedEdges += 1;
			await applyImportedNote(repertoireId, edge.toFenKey, { comment, nags });
			if (colorToMove(fromFenKey) === color) {
				const existing = await getCard(repertoireId, fromFenKey);
				if (!existing) {
					await upsertCard(createFreshCard(repertoireId, fromFenKey, edge.san));
					addedCards += 1;
				}
			}
		}
	}
	return {
		importedLines: matching.length,
		skippedLines: lines.length - matching.length,
		addedEdges,
		addedCards
	};
}

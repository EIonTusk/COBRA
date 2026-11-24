/**
 * Import a community publication as a new local repertoire.
 *
 * Reuses the share-link writer, so the importer's own progress on moves they
 * already train elsewhere is kept (issue #97) and everything else starts
 * fresh. The copy remembers which publication and version it came from.
 */
import { colorToMove, fenKeyFromFen } from '$lib/chess/fen';
import { writeImportedRepertoire } from '$lib/storage/share';
import type { Repertoire, RepertoireNode } from '$lib/types';
import type { CommunityTreeV1, PublicationDetail } from './types';

export async function importCommunityPublication(
	pub: Pick<PublicationDetail, 'id' | 'title' | 'version' | 'tree'>,
	now: number = Date.now()
): Promise<Repertoire> {
	const { tree } = pub;
	const source: Repertoire = {
		id: '',
		name: pub.title,
		color: tree.color,
		rootFen: tree.rootFen,
		rootFenKey: fenKeyFromFen(tree.rootFen),
		createdAt: now,
		updatedAt: now,
		coverageGoal: 100,
		communitySource: { publicationId: pub.id, version: pub.version }
	};
	return writeImportedRepertoire(
		source,
		toRepertoireNodes(tree, now),
		cardSlots(tree),
		tree.ideaCards.map((c) => ({ fenKey: c.fenKey, prompt: c.prompt, answer: c.answer })),
		now
	);
}

/** The published tree as stored nodes (repertoire id is filled in by the writer). */
export function toRepertoireNodes(tree: CommunityTreeV1, now: number): RepertoireNode[] {
	return tree.nodes.map((n) => {
		const node: RepertoireNode = {
			repertoireId: '',
			fenKey: n.fenKey,
			children: n.children.map((e) => ({
				san: e.san,
				uci: e.uci,
				toFenKey: e.toFenKey,
				...(e.annotation ? { annotation: e.annotation } : {}),
				updatedAt: now
			})),
			updatedAt: now
		};
		if (n.comment) node.comment = n.comment;
		if (n.nags?.length) node.nags = [...n.nags];
		return node;
	});
}

/**
 * One card per position where it's the repertoire side's move, on the first
 * (main) move, the same rule the PGN import follows.
 */
export function cardSlots(tree: CommunityTreeV1): Array<{ fenKey: string; expectedSan: string }> {
	const slots: Array<{ fenKey: string; expectedSan: string }> = [];
	for (const n of tree.nodes) {
		if (n.children.length === 0 || colorToMove(n.fenKey) !== tree.color) continue;
		slots.push({ fenKey: n.fenKey, expectedSan: n.children[0].san });
	}
	return slots;
}

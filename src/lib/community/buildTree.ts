/**
 * Build the community-publishable form of a repertoire.
 *
 * Hard rule: no training progress and no mistakes ever leave the device. This
 * module therefore
 *  - reads only the `repertoires`, `nodes` and `idea_cards` stores. It never
 *    opens `cards`, `move_progress`, `mistakes`, `gaps`, `spar_games`,
 *    `position_wdl` or any sync data, and it does not reuse
 *    `buildShareBundle` (which carries cards);
 *  - builds every output object field by field from an allow-list. Nothing is
 *    spread or deep-cloned from a stored row, so a field added to a stored
 *    type later can't ride along by accident;
 *  - leaves out shelved (disabled) lines and every position reachable only
 *    through them.
 * The Worker enforces the same allow-list on its side and rejects anything
 * extra (worker/src/community/tree.ts).
 */
import { getRepertoire } from '$lib/storage/repertoires';
import { listNodes } from '$lib/storage/nodes';
import { listIdeaCards } from '$lib/storage/ideaCards';
import { liveReachableFenKeys } from '$lib/tree/traversal';
import type { RepertoireNode } from '$lib/types';
import {
	COMMUNITY_LIMITS,
	type CommunityEdge,
	type CommunityIdeaCard,
	type CommunityNode,
	type CommunityTreeV1
} from './types';

export interface BuildOptions {
	/** Include node comments, NAGs and move annotations. */
	includeComments: boolean;
	/** Include idea cards (prompt and answer text only). */
	includeIdeaCards: boolean;
}

export interface BuiltTree {
	tree: CommunityTreeV1;
	stats: {
		positions: number;
		moves: number;
		comments: number;
		ideaCards: number;
		/** Moves left out because they are shelved or only reachable through a shelved move. */
		shelvedSkipped: number;
	};
	/** Comments and idea-card text that would be published, for the preview. */
	texts: Array<{ fenKey: string; kind: 'comment' | 'annotation' | 'idea'; text: string }>;
	/** Set when the tree is over a size cap. */
	tooLarge: string | null;
}

export async function buildCommunityTree(
	repertoireId: string,
	opts: BuildOptions
): Promise<BuiltTree | null> {
	const rep = await getRepertoire(repertoireId);
	if (!rep) return null;
	const [nodes, ideas] = await Promise.all([
		listNodes(repertoireId),
		opts.includeIdeaCards ? listIdeaCards(repertoireId) : Promise.resolve([])
	]);
	const byKey = new Map<string, RepertoireNode>(nodes.map((n) => [n.fenKey, n]));
	const live = liveReachableFenKeys(byKey, rep.rootFenKey);

	const outNodes: CommunityNode[] = [];
	const texts: BuiltTree['texts'] = [];
	let moves = 0;
	let comments = 0;
	let totalMoves = 0;
	for (const n of nodes) totalMoves += n.children.length;

	// Breadth-first from the root so the published order is stable and the
	// root comes first.
	const queue = [rep.rootFenKey];
	const seen = new Set<string>(queue);
	while (queue.length > 0) {
		const key = queue.shift()!;
		const node = byKey.get(key);
		const children: CommunityEdge[] = [];
		for (const e of node?.children ?? []) {
			if (e.disabled || !live.has(e.toFenKey)) continue;
			const edge: CommunityEdge = { san: e.san, uci: e.uci, toFenKey: e.toFenKey };
			if (opts.includeComments && e.annotation?.trim()) {
				edge.annotation = e.annotation.trim();
				texts.push({ fenKey: key, kind: 'annotation', text: edge.annotation });
			}
			children.push(edge);
			moves += 1;
			if (!seen.has(e.toFenKey)) {
				seen.add(e.toFenKey);
				queue.push(e.toFenKey);
			}
		}
		const out: CommunityNode = { fenKey: key, children };
		if (opts.includeComments && node) {
			const comment = node.comment?.trim();
			if (comment) {
				out.comment = comment;
				comments += 1;
				texts.push({ fenKey: key, kind: 'comment', text: comment });
			}
			if (node.nags?.length) out.nags = node.nags.filter((x) => Number.isInteger(x)).slice(0, 8);
		}
		outNodes.push(out);
	}

	const ideaCards: CommunityIdeaCard[] = [];
	for (const c of ideas) {
		if (!seen.has(c.fenKey) || !c.prompt?.trim()) continue;
		const card: CommunityIdeaCard = { fenKey: c.fenKey, prompt: c.prompt.trim() };
		if (c.answer?.trim()) card.answer = c.answer.trim();
		ideaCards.push(card);
		texts.push({
			fenKey: c.fenKey,
			kind: 'idea',
			text: card.answer ? `${card.prompt} → ${card.answer}` : card.prompt
		});
	}

	const tree: CommunityTreeV1 = {
		version: 1,
		color: rep.color,
		rootFen: rep.rootFen,
		nodes: outNodes,
		ideaCards
	};
	return {
		tree,
		stats: {
			positions: outNodes.length,
			moves,
			comments,
			ideaCards: ideaCards.length,
			shelvedSkipped: totalMoves - moves
		},
		texts,
		tooLarge: sizeProblem(tree)
	};
}

function sizeProblem(tree: CommunityTreeV1): string | null {
	const L = COMMUNITY_LIMITS;
	if (tree.nodes.length > L.maxPositions) {
		return `This repertoire has ${tree.nodes.length} positions; community openings are limited to ${L.maxPositions}.`;
	}
	if (tree.ideaCards.length > L.maxIdeaCards) {
		return `At most ${L.maxIdeaCards} idea cards can be published.`;
	}
	const bytes = JSON.stringify(tree).length;
	if (bytes > L.maxBytes) {
		return `This repertoire is ${Math.round(bytes / 1000)} KB; the limit is ${L.maxBytes / 1000} KB. Try leaving out comments.`;
	}
	for (const n of tree.nodes) {
		if ((n.comment?.length ?? 0) > L.maxComment) {
			return `A comment is longer than ${L.maxComment} characters.`;
		}
		for (const e of n.children) {
			if ((e.annotation?.length ?? 0) > L.maxAnnotation) {
				return `A move annotation is longer than ${L.maxAnnotation} characters.`;
			}
		}
	}
	for (const c of tree.ideaCards) {
		if (c.prompt.length > L.maxIdeaPrompt || (c.answer?.length ?? 0) > L.maxIdeaAnswer) {
			return 'An idea card is longer than the limit.';
		}
	}
	return null;
}

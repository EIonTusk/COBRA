/**
 * Wire format of a community opening. Shared by the app (which builds it) and
 * the Worker (which validates it), so both sides agree on exactly which
 * fields exist.
 *
 * It holds the repertoire's TREE and nothing else: moves, the author's
 * comments and NAGs, and the text of idea cards. Training progress (FSRS
 * state, due dates, review history), mistakes, gaps, spar games, explorer
 * statistics and sync data have no field here, and the Worker rejects a
 * publish that carries any field not listed below.
 *
 * Pure types only: imported by the app's TypeScript and the Worker's.
 */

export const COMMUNITY_TREE_VERSION = 1;

export interface CommunityTreeV1 {
	version: 1;
	color: 'white' | 'black';
	/** Full FEN of the repertoire's starting position. */
	rootFen: string;
	nodes: CommunityNode[];
	ideaCards: CommunityIdeaCard[];
}

export interface CommunityNode {
	/** EPD fen key, the same key the app stores nodes under. */
	fenKey: string;
	comment?: string;
	nags?: number[];
	children: CommunityEdge[];
}

export interface CommunityEdge {
	san: string;
	uci: string;
	/** Position after the move. Recomputed and checked by the Worker. */
	toFenKey: string;
	annotation?: string;
}

/** An idea card's text only: the prompt and answer at a position. */
export interface CommunityIdeaCard {
	fenKey: string;
	prompt: string;
	answer?: string;
}

/** Field allow-lists. Anything else in a publish is rejected. */
export const TREE_FIELDS = ['version', 'color', 'rootFen', 'nodes', 'ideaCards'] as const;
export const NODE_FIELDS = ['fenKey', 'comment', 'nags', 'children'] as const;
export const EDGE_FIELDS = ['san', 'uci', 'toFenKey', 'annotation'] as const;
export const IDEA_FIELDS = ['fenKey', 'prompt', 'answer'] as const;

/** Size caps, enforced by the Worker and checked by the app before upload. */
export const COMMUNITY_LIMITS = {
	maxPositions: 5000,
	maxIdeaCards: 2000,
	maxBytes: 1_000_000,
	maxComment: 2000,
	maxAnnotation: 500,
	maxNags: 8,
	maxIdeaPrompt: 500,
	maxIdeaAnswer: 2000,
	maxTitle: 80,
	maxDescription: 2000,
	maxTags: 8,
	maxTag: 24,
	maxChangelog: 200
} as const;

/** Publication metadata the app sends alongside the tree. */
export interface PublishMeta {
	title: string;
	description?: string;
	tags?: string[];
	visibility: 'public' | 'unlisted';
	showAuthor: boolean;
	changelog?: string;
	/** Set when the published tree was itself imported from a publication. */
	forkedFrom?: string | null;
}

/** A publication as the Worker returns it in listings. */
export interface PublicationSummary {
	id: string;
	title: string;
	description: string;
	tags: string[];
	color: 'white' | 'black';
	rootFenKey: string;
	openings: Array<[string, string]>;
	visibility: 'public' | 'unlisted';
	/** Lichess username, or null when the author chose to stay anonymous. */
	author: string | null;
	status: 'active' | 'hidden' | 'removed';
	version: number;
	positionCount: number;
	moveCount: number;
	ideaCount: number;
	importCount: number;
	forkedFrom: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface PublicationDetail extends PublicationSummary {
	tree: CommunityTreeV1;
	changelog: string;
}

/** One row of the position index: a move community repertoires contain. */
export interface CommunityMoveCount {
	san: string;
	/** Distinct people whose listed repertoires contain the move. */
	owners: number;
}

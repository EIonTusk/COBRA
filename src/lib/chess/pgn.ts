import { parsePgn, makePgn, startingPosition, defaultGame, ChildNode } from 'chessops/pgn';
import type { Game, PgnNodeData } from 'chessops/pgn';
import { parseSan, makeSanAndPlay } from 'chessops/san';
import { makeFen } from 'chessops/fen';
import { makeUci } from 'chessops/util';
import type { Position } from 'chessops/chess';

import type { Edge } from '$lib/types';

export interface ParsedLine {
	headers: Map<string, string>;
	comments?: string[];
	rootFen: string;
	rootFenKey: string;
	edges: Array<{ fromFenKey: string; edge: Edge; comment?: string; nags?: number[] }>;
}

export function parseRepertoirePgn(pgn: string): ParsedLine[] {
	const games = parsePgn(pgn);
	const lines: ParsedLine[] = [];
	for (const game of games) {
		const posResult = startingPosition(game.headers);
		if (posResult.isErr) continue;
		const pos = posResult.value;
		const rootFen = makeFen(pos.toSetup());
		const rootFenKey = makeFen(pos.toSetup(), { epd: true });
		const edges: ParsedLine['edges'] = [];
		walk(game.moves, pos, edges);
		lines.push({
			headers: game.headers,
			comments: game.comments,
			rootFen,
			rootFenKey,
			edges
		});
	}
	return lines;
}

function walk(
	node: { children: ChildNode<PgnNodeData>[] },
	pos: Position,
	out: ParsedLine['edges']
) {
	const fromFenKey = makeFen(pos.toSetup(), { epd: true });
	for (const child of node.children) {
		const move = parseSan(pos, child.data.san);
		if (!move) continue;
		const forked = pos.clone();
		const san = makeSanAndPlay(forked, move);
		const uci = makeUci(move);
		const toFenKey = makeFen(forked.toSetup(), { epd: true });
		out.push({
			fromFenKey,
			edge: { san, uci, toFenKey },
			comment: child.data.comments?.join(' ') || undefined,
			nags: child.data.nags
		});
		walk(child, forked, out);
	}
}

export interface ExportNode {
	fenKey: string;
	comment?: string;
	nags?: number[];
	children: Edge[];
}

/**
 * Export a repertoire subtree as a PGN string.
 * Caller supplies a map fenKey->node and a starting fenKey + starting FEN.
 */
export function exportRepertoirePgn(
	nodesByKey: Map<string, ExportNode>,
	rootFenKey: string,
	headers: Record<string, string> = {}
): string {
	const game: Game<PgnNodeData> = defaultGame();
	for (const [k, v] of Object.entries(headers)) game.headers.set(k, v);
	// chessops won't render correctly without SetUp/FEN for non-initial starts.
	// Callers set headers appropriately.
	buildPgnTree(game.moves, rootFenKey, nodesByKey, new Set());
	return makePgn(game);
}

function buildPgnTree(
	parent: { children: ChildNode<PgnNodeData>[] },
	fromKey: string,
	nodesByKey: Map<string, ExportNode>,
	visited: Set<string>
) {
	if (visited.has(fromKey)) return;
	visited.add(fromKey);
	const node = nodesByKey.get(fromKey);
	if (!node) return;
	for (const edge of node.children) {
		// Import side stores a move's comment/NAGs on the resulting position
		// (the child's fenKey), so when we re-emit PGN we look those up on
		// the destination node. Without this the round-trip drops every note.
		const child = nodesByKey.get(edge.toFenKey);
		const comments = child?.comment ? [child.comment] : undefined;
		const nags = child?.nags && child.nags.length > 0 ? child.nags : undefined;
		const childNode: ChildNode<PgnNodeData> = new ChildNode({
			san: edge.san,
			nags,
			comments,
			startingComments: undefined
		} as PgnNodeData);
		parent.children.push(childNode);
		buildPgnTree(childNode, edge.toFenKey, nodesByKey, visited);
	}
}

export interface RepertoireChapter {
	name: string;
	pgn: string;
}

/**
 * Split a repertoire tree into Lichess-study-friendly chapters.
 *
 * Rule: walk from the root through single-child chains until we hit the first
 * branching node. One chapter per branch from there, each chapter containing
 * the common prefix + that one branch's full subtree. Chapter names are the
 * SAN move path (e.g. "1.e4 c5", "1.e4 e5 2.Nf3").
 *
 * If the tree is a single forced line (no branch anywhere), falls back to one
 * chapter named after the repertoire.
 *
 * Why split on the *first* branch only? Recursive splitting explodes the
 * chapter count for real opening repertoires — a complete 1.e4 book can
 * easily produce 200+ chapters if you split at every branching depth.
 * One-level split gives the natural "one chapter per main line" structure
 * (Sicilian / Caro / French / etc.) that matches how players think about
 * openings, with all sub-variations preserved as branches within the chapter.
 */
export function chapterizeRepertoire(
	nodesByKey: Map<string, ExportNode>,
	rootFenKey: string,
	rootFen: string,
	repName: string,
	color: 'white' | 'black'
): RepertoireChapter[] {
	const makeHeaders = (chapterEvent: string): Record<string, string> => {
		const h: Record<string, string> = {
			Event: chapterEvent,
			Site: 'COBRA',
			White: color === 'white' ? 'Repertoire' : 'Opponent',
			Black: color === 'black' ? 'Repertoire' : 'Opponent',
			Result: '*'
		};
		// Chessops skips [SetUp]/[FEN] on the default initial position; set
		// them explicitly whenever the rep's root is anything else so Lichess
		// loads the chapter from the right place.
		if (rootFen.split(' ')[0] !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR') {
			h.SetUp = '1';
			h.FEN = rootFen;
		}
		return h;
	};

	const { prefix, splitAt } = findFirstSplit(nodesByKey, rootFenKey);
	const splitNode = nodesByKey.get(splitAt);
	if (!splitNode || splitNode.children.length < 2) {
		const pgn = exportRepertoirePgn(nodesByKey, rootFenKey, makeHeaders(repName));
		return [{ name: repName, pgn }];
	}

	const chapters: RepertoireChapter[] = [];
	for (const edge of splitNode.children) {
		const pruned = pruneToSingleChildAt(nodesByKey, splitAt, edge);
		const label = buildMovePath(prefix, edge, rootFen);
		const pgn = exportRepertoirePgn(pruned, rootFenKey, makeHeaders(`${repName} · ${label}`));
		chapters.push({ name: label, pgn });
	}
	return chapters;
}

function findFirstSplit(
	nodes: Map<string, ExportNode>,
	rootKey: string
): { prefix: Edge[]; splitAt: string } {
	const prefix: Edge[] = [];
	let current = rootKey;
	const seen = new Set<string>();
	while (!seen.has(current)) {
		seen.add(current);
		const node = nodes.get(current);
		if (!node || node.children.length !== 1) break;
		const only = node.children[0];
		prefix.push(only);
		current = only.toFenKey;
	}
	return { prefix, splitAt: current };
}

/**
 * Shallow-copy `nodes`, replacing the entry at `splitAt` with a version that
 * exposes only `keepEdge`. The downstream subtree is untouched — variations
 * below the kept edge still render fully. The other branches' descendants
 * stay in the map but are unreachable from the root walk.
 */
function pruneToSingleChildAt(
	nodes: Map<string, ExportNode>,
	splitAt: string,
	keepEdge: Edge
): Map<string, ExportNode> {
	const out = new Map(nodes);
	const n = out.get(splitAt);
	if (!n) return out;
	out.set(splitAt, { ...n, children: [keepEdge] });
	return out;
}

/**
 * Turn a prefix + one branching edge into a SAN move-path string like
 * "1.e4 c5" or "1.d4 Nf6 2.c4 e6". Move numbers and side-to-move come from
 * `rootFen` so non-standard starts (mid-game repertoires) still number
 * correctly.
 */
function buildMovePath(prefix: Edge[], branch: Edge, rootFen: string): string {
	const parts = rootFen.split(' ');
	let whiteToMove = parts[1] !== 'b';
	let moveNo = parseInt(parts[5] ?? '1', 10) || 1;
	const tokens: string[] = [];
	for (const edge of [...prefix, branch]) {
		if (whiteToMove) tokens.push(`${moveNo}.${edge.san}`);
		else tokens.push(edge.san);
		if (!whiteToMove) moveNo += 1;
		whiteToMove = !whiteToMove;
	}
	return tokens.join(' ');
}

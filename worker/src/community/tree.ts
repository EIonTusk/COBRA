/**
 * Server-side validation of a published tree.
 *
 * The Worker never trusts the app's JSON. It
 *  - rejects any field outside the allow-lists in `types.ts`, so a client bug
 *    can't smuggle training progress or mistakes into a public tree (the
 *    publish fails loudly instead of the field being dropped silently);
 *  - replays every move with chessops from the root, checks it is legal, that
 *    its SAN and resulting position match, and that every node is reachable;
 *  - enforces size caps;
 *  - rebuilds the stored tree from the validated values only.
 */
import { Chess } from 'chessops/chess';
import { makeFen, parseFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { parseUci } from 'chessops/util';
import {
	COMMUNITY_LIMITS as L,
	EDGE_FIELDS,
	IDEA_FIELDS,
	NODE_FIELDS,
	TREE_FIELDS,
	type CommunityEdge,
	type CommunityIdeaCard,
	type CommunityNode,
	type CommunityTreeV1
} from './types';

export class TreeError extends Error {}

export interface ValidatedTree {
	tree: CommunityTreeV1;
	rootFenKey: string;
	positionCount: number;
	moveCount: number;
	ideaCount: number;
}

/** EPD fen key of a position, matching the app's `fenKeyFromFen`. */
export function fenKeyOf(pos: Chess): string {
	return makeFen(pos.toSetup(), { epd: true });
}

function positionFromKey(fenKey: string): Chess {
	// An EPD key has no move counters; any values give the same legal moves.
	const setup = parseFen(`${fenKey} 0 1`);
	if (setup.isErr) throw new TreeError(`invalid position ${fenKey}`);
	const pos = Chess.fromSetup(setup.value);
	if (pos.isErr) throw new TreeError(`illegal position ${fenKey}`);
	return pos.value;
}

function onlyFields(obj: unknown, allowed: readonly string[], where: string): Record<string, unknown> {
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new TreeError(`${where}: not an object`);
	for (const k of Object.keys(obj)) {
		if (!allowed.includes(k)) throw new TreeError(`${where}: unexpected field "${k}"`);
	}
	return obj as Record<string, unknown>;
}

function optText(v: unknown, max: number, where: string): string | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== 'string') throw new TreeError(`${where}: must be text`);
	const t = v.trim();
	if (t.length > max) throw new TreeError(`${where}: longer than ${max} characters`);
	return t || undefined;
}

export function validateTree(raw: unknown): ValidatedTree {
	const top = onlyFields(raw, TREE_FIELDS, 'tree');
	if (top.version !== 1) throw new TreeError('tree: unsupported version');
	if (top.color !== 'white' && top.color !== 'black') throw new TreeError('tree: bad color');
	if (typeof top.rootFen !== 'string') throw new TreeError('tree: rootFen missing');
	const rootSetup = parseFen(top.rootFen);
	if (rootSetup.isErr) throw new TreeError('tree: invalid rootFen');
	const rootPos = Chess.fromSetup(rootSetup.value);
	if (rootPos.isErr) throw new TreeError('tree: illegal rootFen');
	const rootFen = makeFen(rootPos.value.toSetup());
	const rootFenKey = fenKeyOf(rootPos.value);

	if (!Array.isArray(top.nodes)) throw new TreeError('tree: nodes must be a list');
	if (top.nodes.length > L.maxPositions) {
		throw new TreeError(`tree: more than ${L.maxPositions} positions`);
	}
	const ideasRaw = top.ideaCards ?? [];
	if (!Array.isArray(ideasRaw)) throw new TreeError('tree: ideaCards must be a list');
	if (ideasRaw.length > L.maxIdeaCards) throw new TreeError(`tree: more than ${L.maxIdeaCards} idea cards`);

	// First pass: shape-check every node and index by fen key.
	const byKey = new Map<string, Record<string, unknown>>();
	for (const [i, n] of top.nodes.entries()) {
		const node = onlyFields(n, NODE_FIELDS, `node ${i}`);
		if (typeof node.fenKey !== 'string') throw new TreeError(`node ${i}: fenKey missing`);
		if (byKey.has(node.fenKey)) throw new TreeError(`node ${i}: duplicate position`);
		if (!Array.isArray(node.children)) throw new TreeError(`node ${i}: children must be a list`);
		byKey.set(node.fenKey, node);
	}
	if (!byKey.has(rootFenKey)) throw new TreeError('tree: root position missing');

	// Second pass: replay from the root, breadth first.
	const out = new Map<string, CommunityNode>();
	const queue: string[] = [rootFenKey];
	let moveCount = 0;
	while (queue.length > 0) {
		const key = queue.shift()!;
		if (out.has(key)) continue;
		const node = byKey.get(key);
		if (!node) throw new TreeError(`move leads to a position with no node: ${key}`);
		const pos = positionFromKey(key);
		const children: CommunityEdge[] = [];
		const seenTo = new Set<string>();
		for (const [j, e] of (node.children as unknown[]).entries()) {
			const where = `move ${j} at ${key}`;
			const edge = onlyFields(e, EDGE_FIELDS, where);
			if (typeof edge.uci !== 'string' || typeof edge.san !== 'string') {
				throw new TreeError(`${where}: san and uci required`);
			}
			const move = parseUci(edge.uci);
			if (!move || !pos.isLegal(move)) throw new TreeError(`${where}: illegal move ${edge.uci}`);
			const san = makeSan(pos, move);
			if (san !== edge.san) throw new TreeError(`${where}: SAN ${edge.san} does not match ${san}`);
			const next = pos.clone();
			next.play(move);
			const toFenKey = fenKeyOf(next);
			if (edge.toFenKey !== toFenKey) throw new TreeError(`${where}: wrong resulting position`);
			if (seenTo.has(toFenKey)) throw new TreeError(`${where}: duplicate move`);
			seenTo.add(toFenKey);
			const annotation = optText(edge.annotation, L.maxAnnotation, `${where} annotation`);
			children.push({ san, uci: edge.uci, toFenKey, ...(annotation ? { annotation } : {}) });
			moveCount += 1;
			if (!out.has(toFenKey)) queue.push(toFenKey);
		}
		const comment = optText(node.comment, L.maxComment, `comment at ${key}`);
		let nags: number[] | undefined;
		if (node.nags !== undefined) {
			if (
				!Array.isArray(node.nags) ||
				node.nags.length > L.maxNags ||
				!node.nags.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)
			) {
				throw new TreeError(`nags at ${key}: invalid`);
			}
			nags = node.nags.length ? [...(node.nags as number[])] : undefined;
		}
		out.set(key, { fenKey: key, ...(comment ? { comment } : {}), ...(nags ? { nags } : {}), children });
	}
	if (out.size !== byKey.size) throw new TreeError('tree: some positions are not reachable from the root');

	const ideaCards: CommunityIdeaCard[] = [];
	const seenIdea = new Set<string>();
	for (const [i, c] of ideasRaw.entries()) {
		const card = onlyFields(c, IDEA_FIELDS, `idea card ${i}`);
		if (typeof card.fenKey !== 'string' || !out.has(card.fenKey)) {
			throw new TreeError(`idea card ${i}: position not in the tree`);
		}
		if (seenIdea.has(card.fenKey)) throw new TreeError(`idea card ${i}: duplicate position`);
		seenIdea.add(card.fenKey);
		const prompt = optText(card.prompt, L.maxIdeaPrompt, `idea card ${i} prompt`);
		if (!prompt) throw new TreeError(`idea card ${i}: prompt required`);
		const answer = optText(card.answer, L.maxIdeaAnswer, `idea card ${i} answer`);
		ideaCards.push({ fenKey: card.fenKey, prompt, ...(answer ? { answer } : {}) });
	}

	const tree: CommunityTreeV1 = {
		version: 1,
		color: top.color,
		rootFen,
		nodes: [...out.values()],
		ideaCards
	};
	return { tree, rootFenKey, positionCount: out.size, moveCount, ideaCount: ideaCards.length };
}

/** Every (position, move) pair of a stored tree, for the position index. */
export function treeMovePairs(tree: CommunityTreeV1): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	for (const n of tree.nodes) for (const e of n.children) pairs.push([n.fenKey, e.san]);
	return pairs;
}

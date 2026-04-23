import type { Card, RepertoireNode } from '$lib/types';
import { furthestNonBranchingFenKey } from './traversal';

/**
 * Group a set of due cards line-first: positions sharing the same first
 * branching choice from the repertoire's "line anchor" (the first branching
 * node at or below the starting position) are drilled contiguously, in
 * plies-from-root order within each group.
 *
 * The point is to preserve move-sequence memory — the user walks a whole
 * opening before switching to the next rather than shuffling flashcards.
 *
 * Strongly-overdue cards short-circuit line order: any card past the
 * `overdueCapMs` threshold pulls its entire line block to the front so a
 * user who ends a session early doesn't defer a badly-overdue card behind
 * fresher ones in the current line.
 */

export interface LineOrderedQueue {
	cards: Card[];
	/**
	 * Label per card, same length/indexing as `cards`. `null` for cards in the
	 * forced-prefix region (before the line-anchor) or orphans (unreachable
	 * from root). Otherwise the SAN of the first branching edge taken at the
	 * line anchor to reach that card.
	 */
	lineLabels: (string | null)[];
	/** Indices at which the line label changes. 0 is always included when non-empty. */
	lineBoundaries: Set<number>;
}

export interface LineOrderOptions {
	rootFenKey: string;
	startingFenKey?: string | null;
	/**
	 * Cards overdue by more than this many ms bypass line grouping and their
	 * whole line block is pulled to the front. Omit to disable the cap
	 * (e.g. for mistake/retrain modes where `dueAt` isn't FSRS-meaningful).
	 */
	overdueCapMs?: number;
	now?: number;
}

interface Entry {
	card: Card;
	lineLabel: string | null;
}

export function buildLineFirstQueue(
	cards: Card[],
	nodes: Map<string, RepertoireNode>,
	opts: LineOrderOptions
): LineOrderedQueue {
	const { rootFenKey, startingFenKey = null, overdueCapMs, now = Date.now() } = opts;

	if (cards.length === 0) {
		return { cards: [], lineLabels: [], lineBoundaries: new Set() };
	}

	const byKey = new Map(cards.map((c) => [c.fenKey, c]));
	const remaining = new Set(byKey.keys());
	const visited = new Set<string>();

	// The "line anchor" is the first branching node at or below the rep's
	// starting position. Edges taken at this node become line labels.
	// For a 1.e4 repertoire with a linear trunk through 2.Nf3 Nc6, the
	// anchor is after 2…Nc6 — the first position where Bb5/Bc4/… branches.
	const anchor = furthestNonBranchingFenKey(nodes, startingFenKey ?? rootFenKey);

	const entries: Entry[] = [];

	function walk(key: string, labelInForce: string | null) {
		if (visited.has(key)) return;
		visited.add(key);
		const card = byKey.get(key);
		if (card) {
			entries.push({ card, lineLabel: labelInForce });
			remaining.delete(key);
		}
		const node = nodes.get(key);
		if (!node) return;
		const atAnchor = key === anchor;
		for (const edge of node.children) {
			const childLabel = atAnchor ? edge.san : labelInForce;
			walk(edge.toFenKey, childLabel);
		}
	}

	walk(rootFenKey, null);

	// Orphans: cards whose fenKey isn't reachable from the root. Append by
	// dueAt so the earliest-due orphan comes first. Labeled null — they'll
	// cluster with other unlabeled cards at the tail.
	if (remaining.size > 0) {
		const orphans = [...remaining].map((k) => byKey.get(k)!).sort((a, b) => a.dueAt - b.dueAt);
		for (const card of orphans) entries.push({ card, lineLabel: null });
	}

	// Collapse the DFS stream into contiguous line blocks (same label).
	interface Block {
		label: string | null;
		items: Entry[];
		minDue: number;
		hasOverdue: boolean;
	}
	const blocks: Block[] = [];
	const cutoff = overdueCapMs !== undefined ? now - overdueCapMs : -Infinity;
	for (const e of entries) {
		const last = blocks[blocks.length - 1];
		const overdue = e.card.dueAt < cutoff;
		if (last && last.label === e.lineLabel) {
			last.items.push(e);
			if (e.card.dueAt < last.minDue) last.minDue = e.card.dueAt;
			if (overdue) last.hasOverdue = true;
		} else {
			blocks.push({
				label: e.lineLabel,
				items: [e],
				minDue: e.card.dueAt,
				hasOverdue: overdue
			});
		}
	}

	// If the cap is disabled or nothing is strongly overdue, preserve DFS order.
	// Otherwise, float overdue blocks to the front (ordered by earliest due
	// within each block) and keep the remaining blocks in their original order.
	let ordered: Block[];
	if (overdueCapMs === undefined || !blocks.some((b) => b.hasOverdue)) {
		ordered = blocks;
	} else {
		const overdueBlocks = blocks.filter((b) => b.hasOverdue).sort((a, b) => a.minDue - b.minDue);
		const normalBlocks = blocks.filter((b) => !b.hasOverdue);
		ordered = [...overdueBlocks, ...normalBlocks];
	}

	const outCards: Card[] = [];
	const outLabels: (string | null)[] = [];
	const boundaries = new Set<number>();
	let i = 0;
	let prevLabel: string | null | undefined = undefined;
	for (const block of ordered) {
		for (const e of block.items) {
			if (e.lineLabel !== prevLabel) boundaries.add(i);
			outCards.push(e.card);
			outLabels.push(e.lineLabel);
			prevLabel = e.lineLabel;
			i += 1;
		}
	}

	return { cards: outCards, lineLabels: outLabels, lineBoundaries: boundaries };
}

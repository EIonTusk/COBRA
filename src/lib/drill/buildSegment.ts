import type { AppSettings, Card, IdeaCard, Repertoire, RepertoireNode } from '$lib/types';
import { colorToMove } from '$lib/chess/fen';
import { pathToFenKey } from '$lib/tree/traversal';
import { buildLineFirstQueue } from '$lib/tree/lineOrder';
import {
	dueCards,
	getCard,
	listCards,
	mistakeCards,
	pickBalancedDueCards
} from '$lib/storage/cards';
import { dueIdeaCards } from '$lib/storage/ideaCards';
import { filterActiveMistakes, listMistakes } from '$lib/storage/mistakes';
import { createFreshCard } from '$lib/fsrs/scheduler';
import { nodesMap } from '$lib/storage/nodes';
import type { DrillMode, DrillSegment } from './types';

/**
 * Cards overdue by more than this bypass line ordering and float to the
 * top of their segment. Disabled in mistake/retrain modes (their `dueAt`
 * isn't FSRS-meaningful).
 */
const OVERDUE_CAP_MS = 24 * 60 * 60 * 1000;

/**
 * "Well-learned" = the user has demonstrated reliable recall and the FSRS
 * schedule reflects it. Used by line-walk to decide whether a prefix card
 * gets drilled (reinforce recall) or animated past (already known). Card
 * must be in FSRS Review state and meet the configured stability threshold.
 */
function isWellLearned(card: Card, threshold: number): boolean {
	const state = card.fsrs.state;
	const stability = typeof card.fsrs.stability === 'number' ? card.fsrs.stability : 0;
	return state === 2 && stability >= threshold;
}

interface LineWalkResult {
	cards: Card[];
	walkStarts: number[];
	walkFenKeys: Set<string>[];
	dueOriginalKeys: Set<string>;
}

/**
 * Greedy line-walk session builder. Iterates the due-card pool in
 * (depth desc, dueAt asc) order; each candidate's full path back to the
 * line head is admitted only if it fits the session/new-card budgets. The
 * deepest candidate's walk subsumes shallower siblings on the same line,
 * so deep-first iteration avoids duplicate prefixes for the same line
 * while keeping the deepest position the schedule surfaced.
 *
 * Each walk adds an entry to `walkStarts`/`walkFenKeys` so the runner can
 * sequence Learn → Train passes per walk, and `dueOriginalKeys` records
 * which fenKeys were FSRS-due (vs. line-walk prefix steps that don't
 * update FSRS state on rate).
 */
async function pickWithLineWalk(
	pool: Card[],
	rep: Repertoire,
	nodes: Map<string, RepertoireNode>,
	settings: AppSettings,
	sessionCap: number,
	newCap: number
): Promise<LineWalkResult> {
	const lineHead = rep.rootFenKey;
	const wellLearnedDays = settings.drillWellLearnedDays ?? 7;

	const depthByKey = new Map<string, number>();
	for (const c of pool) {
		if (depthByKey.has(c.fenKey)) continue;
		const path = pathToFenKey(nodes, lineHead, c.fenKey);
		depthByKey.set(c.fenKey, path ? path.length : -1);
	}
	const sortedPool = pool.slice().sort((a, b) => {
		const dA = depthByKey.get(a.fenKey) ?? -1;
		const dB = depthByKey.get(b.fenKey) ?? -1;
		if (dA !== dB) return dB - dA;
		return a.dueAt - b.dueAt;
	});

	const out: Card[] = [];
	const walkStarts: number[] = [];
	const walkFenKeys: Set<string>[] = [];
	const dueOriginalKeys = new Set<string>();
	const ledBy = new Set<string>();
	const poolKeys = new Set<string>();
	for (const c of pool) poolKeys.add(c.fenKey);
	const uniqueNewSeen = new Set<string>();
	let totalRemaining = Math.max(0, sessionCap);
	let newRemaining = Math.max(0, newCap);
	const admittedFenKeys = new Set<string>();

	for (const candidate of sortedPool) {
		if (totalRemaining <= 0) break;
		if (newRemaining <= 0) break;
		if (ledBy.has(candidate.fenKey)) continue;
		if (admittedFenKeys.has(candidate.fenKey)) continue;

		const walk: Card[] = [];
		if (candidate.fenKey !== lineHead) {
			const path = pathToFenKey(nodes, lineHead, candidate.fenKey);
			if (path) {
				for (let i = 0; i < path.length; i++) {
					const fenKeyBeforeEdge = i === 0 ? lineHead : path[i - 1].toFenKey;
					if (fenKeyBeforeEdge === candidate.fenKey) break;
					if (colorToMove(fenKeyBeforeEdge) !== rep.color) continue;
					const stored = await getCard(rep.id, fenKeyBeforeEdge);
					if (!stored) continue;
					if (isWellLearned(stored, wellLearnedDays)) continue;
					walk.push(stored);
				}
			}
		}
		walk.push(candidate);

		const newInWalk = walk.reduce(
			(sum, c) => sum + (!c.lastReview && !uniqueNewSeen.has(c.fenKey) ? 1 : 0),
			0
		);
		const walkHasNew = walk.some((c) => !c.lastReview);
		const eventCost = walk.length * (walkHasNew ? 2 : 1);
		if (eventCost > totalRemaining) continue;
		if (newInWalk > newRemaining) continue;

		ledBy.add(candidate.fenKey);
		const walkStart = out.length;
		const fenSet = new Set<string>();
		for (const c of walk) {
			out.push(c);
			fenSet.add(c.fenKey);
			admittedFenKeys.add(c.fenKey);
			if (poolKeys.has(c.fenKey)) dueOriginalKeys.add(c.fenKey);
			if (!c.lastReview) uniqueNewSeen.add(c.fenKey);
		}
		walkStarts.push(walkStart);
		walkFenKeys.push(fenSet);
		totalRemaining -= eventCost;
		newRemaining -= newInWalk;
	}

	return { cards: out, walkStarts, walkFenKeys, dueOriginalKeys };
}

/** Apply line-first ordering + line-label assignment to a card list. */
function sortByLineOrder(
	cards: Card[],
	rep: Repertoire,
	nodes: Map<string, RepertoireNode>,
	applyOverdueCap: boolean
): { cards: Card[]; lineLabelByKey: Map<string, string | null> } {
	const lineLabelByKey = new Map<string, string | null>();
	if (cards.length === 0) return { cards, lineLabelByKey };
	const ordered = buildLineFirstQueue(cards, nodes, {
		rootFenKey: rep.rootFenKey,
		startingFenKey: rep.startingFenKey ?? null,
		overdueCapMs: applyOverdueCap ? OVERDUE_CAP_MS : undefined
	});
	for (let i = 0; i < ordered.cards.length; i++) {
		lineLabelByKey.set(ordered.cards[i].fenKey, ordered.lineLabels[i]);
	}
	return { cards: ordered.cards, lineLabelByKey };
}

/**
 * Build a single-repertoire drill segment for the given mode. Honours the
 * line-walk setting in `due` mode; falls back to balanced FSRS picking
 * otherwise. Mistake/retrain modes skip line-walk and just emit the
 * stored mistakes as cards.
 */
export async function buildSegment(
	rep: Repertoire,
	mode: DrillMode,
	settings: AppSettings,
	options?: { includeIdeas?: boolean }
): Promise<DrillSegment> {
	const nodes = await nodesMap(rep.id);
	const includeIdeas = options?.includeIdeas ?? mode === 'due';
	const ideaQueue: IdeaCard[] =
		includeIdeas && mode === 'due'
			? await dueIdeaCards(rep.id, Date.now(), settings.drillSessionCap)
			: [];

	if (mode === 'mistakes') {
		const cards = await mistakeCards(rep.id, settings.drillSessionCap);
		const dueOriginalKeys = new Set<string>(cards.map((c) => c.fenKey));
		const sorted = sortByLineOrder(cards, rep, nodes, false);
		return {
			rep,
			nodes,
			mode,
			cards: sorted.cards,
			lineLabelByKey: sorted.lineLabelByKey,
			walkStarts: [],
			walkFenKeys: [],
			dueOriginalKeys,
			ideaQueue
		};
	}

	if (mode === 'retrain') {
		const pending = await filterActiveMistakes(
			await listMistakes({
				status: 'pending',
				repertoireId: rep.id,
				limit: settings.drillSessionCap
			})
		);
		const cards: Card[] = [];
		for (const m of pending) {
			const existing = await getCard(rep.id, m.fenKey);
			cards.push(existing ?? createFreshCard(rep.id, m.fenKey, m.expectedSan, Date.now()));
		}
		const dueOriginalKeys = new Set<string>(cards.map((c) => c.fenKey));
		const sorted = sortByLineOrder(cards, rep, nodes, false);
		return {
			rep,
			nodes,
			mode,
			cards: sorted.cards,
			lineLabelByKey: sorted.lineLabelByKey,
			walkStarts: [],
			walkFenKeys: [],
			dueOriginalKeys,
			ideaQueue
		};
	}

	// 'due' mode.
	const pool = await dueCards(rep.id, Date.now(), settings.drillSessionCap * 5);
	const lineWalkOn = (settings.drillIntermediateMoves ?? 'play') === 'play';

	if (lineWalkOn) {
		const result = await pickWithLineWalk(
			pool,
			rep,
			nodes,
			settings,
			settings.drillSessionCap,
			settings.dailyNewCardCap
		);
		// Line-walk preserves the candidate-led ordering verbatim — the queue
		// is already a sequence of full per-line walks. Skip the line-first
		// re-sort, which would dedup duplicate fenKeys across walks.
		const lineLabelByKey = new Map<string, string | null>();
		return {
			rep,
			nodes,
			mode,
			cards: result.cards,
			lineLabelByKey,
			walkStarts: result.walkStarts,
			walkFenKeys: result.walkFenKeys,
			dueOriginalKeys: result.dueOriginalKeys,
			ideaQueue
		};
	}

	const due = pickBalancedDueCards(pool, settings.drillSessionCap, settings.dailyNewCardCap);
	const dueOriginalKeys = new Set<string>(due.map((c) => c.fenKey));
	const sorted = sortByLineOrder(due, rep, nodes, true);
	return {
		rep,
		nodes,
		mode,
		cards: sorted.cards,
		lineLabelByKey: sorted.lineLabelByKey,
		walkStarts: [],
		walkFenKeys: [],
		dueOriginalKeys,
		ideaQueue
	};
}

/**
 * Cards whose user-move position has no deeper user-move card in the
 * repertoire — the "tips" of every prepared line. Used by the runner's
 * leaves cycle to seed an extra second-pass for a segment's deepest moves.
 */
export async function collectLeafCards(
	rep: Repertoire,
	nodes: Map<string, RepertoireNode>
): Promise<Card[]> {
	const all = await listCards(rep.id);
	const byKey = new Map(all.map((c) => [c.fenKey, c]));
	const leaves: Card[] = [];
	for (const card of all) {
		const node = nodes.get(card.fenKey);
		if (!node || node.children.length === 0) {
			leaves.push(card);
			continue;
		}
		let hasDeeperCard = false;
		outer: for (const userEdge of node.children) {
			const oppNode = nodes.get(userEdge.toFenKey);
			if (!oppNode) continue;
			for (const oppEdge of oppNode.children) {
				if (byKey.has(oppEdge.toFenKey)) {
					hasDeeperCard = true;
					break outer;
				}
			}
		}
		if (!hasDeeperCard) leaves.push(card);
	}
	return leaves;
}

/**
 * Apply line-first ordering to a leaf-card list, reusing the segment's
 * existing rep + nodes. The returned `lineLabelByKey` is merged into the
 * segment's existing one by callers (so leaves pick up their line labels).
 */
export function sortLeavesByLineOrder(
	leaves: Card[],
	rep: Repertoire,
	nodes: Map<string, RepertoireNode>
): { cards: Card[]; lineLabelByKey: Map<string, string | null> } {
	return sortByLineOrder(leaves, rep, nodes, false);
}

/**
 * Drill events the segment will charge against `drillSessionCap`. Mirrors
 * the cost calculation inside `pickWithLineWalk` so the merged Quick drill
 * can serially deduct each rep's contribution from a shared session
 * budget. Walk-mode segments cost `walkLength × (hasNew ? 2 : 1)` per
 * walk (Train pass replays count); non-walk segments cost one event per
 * card.
 */
export function segmentEventCount(seg: DrillSegment): number {
	if (seg.walkStarts.length === 0) return seg.cards.length;
	let total = 0;
	for (let w = 0; w < seg.walkStarts.length; w++) {
		const start = seg.walkStarts[w];
		const end = w + 1 < seg.walkStarts.length ? seg.walkStarts[w + 1] : seg.cards.length;
		let len = 0;
		let hasNew = false;
		for (let i = start; i < end; i++) {
			len++;
			if (!seg.cards[i].lastReview) hasNew = true;
		}
		total += len * (hasNew ? 2 : 1);
	}
	return total;
}

/** Unique brand-new fenKeys the segment introduces (chargeable to dailyNewCardCap). */
export function segmentNewCount(seg: DrillSegment): number {
	const seen = new Set<string>();
	for (const c of seg.cards) {
		if (!c.lastReview) seen.add(c.fenKey);
	}
	return seen.size;
}

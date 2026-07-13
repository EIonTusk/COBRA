import type { AppSettings, Card, IdeaCard, Repertoire, RepertoireNode } from '$lib/types';
import { colorToMove } from '$lib/chess/fen';
import { pathToFenKey, reachableFenKeys } from '$lib/tree/traversal';
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
 * must be graduated (past its introduction) and meet the configured
 * stability threshold.
 *
 * Relearning (state 3) counts as graduated. It didn't used to, which meant a
 * single slip on a trunk move pinned it into the recall pool of every walk
 * passing through it, indefinitely — the lapse drops its stability, and a
 * prefix step earns no FSRS credit to build that stability back. The lapsed
 * card is still drilled on its own merits whenever it comes up due; it just
 * no longer conscripts every other line into re-drilling it.
 */
function isWellLearned(card: Card, threshold: number): boolean {
	const state = card.fsrs.state;
	const graduated = state === 2 || state === 3;
	const stability = typeof card.fsrs.stability === 'number' ? card.fsrs.stability : 0;
	return graduated && stability >= threshold;
}

interface LineWalkResult {
	cards: Card[];
	walkStarts: number[];
	walkFenKeys: Set<string>[];
	dueOriginalKeys: Set<string>;
}

/**
 * Greedy line-walk session builder.
 *
 * Two-stage construction:
 *
 * 1. **Admit candidates.** Iterate the due-card pool in (depth asc, dueAt
 *    asc) order — shallower lines first. Each candidate's full path back
 *    to the line head is admitted if it fits the session/new-card budgets.
 *    The well-learned filter still drops prefix cards the user has already
 *    consolidated.
 *
 * 2. **Factor out shared prefixes.** Build a trie keyed by fenKey-path
 *    from the line head. A maximal run of nodes whose path is shared by
 *    ≥2 admitted walks is emitted as its OWN walk before the walks fork.
 *    The unique tails follow as their own walks. This produces the
 *    "drill the trunk first, then each line's unique tail" order:
 *
 *    Walks {[A,B,C,D], [A,B,C,E,F], [A,B,G,H]} →
 *    [A,B] · [C] · [D] · [E,F] · [G,H]
 *
 *    Why: on a fresh session the user actively plays the shared base
 *    once (Learn + Train) instead of replaying it once per descendant
 *    walk's Train pass. The runner's per-card lead-in animation still
 *    shows the trunk during each tail walk, but recall is no longer
 *    duplicated.
 *
 * Each emitted walk adds an entry to `walkStarts`/`walkFenKeys` so the
 * runner can sequence Learn → Train per walk, and `dueOriginalKeys`
 * records which fenKeys were FSRS-due (vs. line-walk prefix steps that
 * don't update FSRS state on rate).
 */
async function pickWithLineWalk(
	pool: Card[],
	rep: Repertoire,
	nodes: Map<string, RepertoireNode>,
	settings: AppSettings,
	sessionCap: number,
	newCap: number,
	lineHead: string
): Promise<LineWalkResult> {
	const wellLearnedDays = settings.drillWellLearnedDays ?? 7;

	const depthByKey = new Map<string, number>();
	for (const c of pool) {
		if (depthByKey.has(c.fenKey)) continue;
		const path = pathToFenKey(nodes, lineHead, c.fenKey);
		depthByKey.set(c.fenKey, path ? path.length : -1);
	}
	// Depth-ASC: shallower candidates first so the trunk-extraction step
	// emits shallow shared segments before deep tails, mirroring how a
	// human builds a repertoire.
	const sortedPool = pool.slice().sort((a, b) => {
		const dA = depthByKey.get(a.fenKey) ?? -1;
		const dB = depthByKey.get(b.fenKey) ?? -1;
		if (dA !== dB) return dA - dB;
		return a.dueAt - b.dueAt;
	});

	const poolKeys = new Set<string>();
	for (const c of pool) poolKeys.add(c.fenKey);

	const admittedWalks: Card[][] = [];
	const ledBy = new Set<string>();
	const admittedFenKeys = new Set<string>();
	const uniqueNewSeen = new Set<string>();
	let totalRemaining = Math.max(0, sessionCap);
	let newRemaining = Math.max(0, newCap);

	for (const candidate of sortedPool) {
		if (totalRemaining <= 0) break;
		// Note: an exhausted new-card budget must NOT end the loop — it only
		// disqualifies walks that introduce new cards. Breaking here starved
		// review cards out of the session entirely, and made a `newCap` of 0
		// (the natural way to grind down a large backlog) build an empty one.
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

		// Budget the walk at its INCREMENTAL cost — the cards it adds that no
		// already-admitted walk covers. Trunk extraction emits a shared run
		// once, as its own walk, so charging each candidate for the full path
		// back to the head billed the same trunk moves once per descendant:
		// five lines sharing a six-move trunk were charged 30 events for the
		// six the user actually plays. On a large repertoire (deep lines, heavy
		// sharing) that over-charge consumed the whole session cap on moves
		// that were never emitted, which is why a big due queue barely moved.
		const incremental = walk.filter((c) => !admittedFenKeys.has(c.fenKey));
		const newInWalk = incremental.reduce(
			(sum, c) => sum + (!c.lastReview && !uniqueNewSeen.has(c.fenKey) ? 1 : 0),
			0
		);
		const walkHasNew = incremental.some((c) => !c.lastReview);
		const eventCost = incremental.length * (walkHasNew ? 2 : 1);
		if (eventCost > totalRemaining) continue;
		if (newInWalk > newRemaining) continue;

		ledBy.add(candidate.fenKey);
		for (const c of walk) {
			admittedFenKeys.add(c.fenKey);
			if (!c.lastReview) uniqueNewSeen.add(c.fenKey);
		}
		admittedWalks.push(walk);
		totalRemaining -= eventCost;
		newRemaining -= newInWalk;
	}

	return extractSharedPrefixWalks(admittedWalks, poolKeys);
}

/**
 * Trie node for shared-prefix extraction. `count` is the number of
 * admitted walks descending through this node — count ≥ 2 marks a
 * shared run, count == 1 marks a unique tail.
 */
interface PrefixTrieNode {
	card: Card | null;
	count: number;
	children: Map<string, PrefixTrieNode>;
}

/**
 * Build a fenKey-path trie from admitted walks and emit walks in
 * trunk-first order: a maximal run of shared nodes (count ≥ 2) is
 * flushed as one walk before the trie forks; the per-branch recursion
 * then emits each subtree's own shared run + unique tails. Sibling
 * branches are visited shared-first (more walks descending → drilled
 * earlier) so the most-leveraged moves get active-recall priority.
 *
 * Exported for unit testing. Pure: no IDB / engine / settings reads.
 */
export function extractSharedPrefixWalks(
	admittedWalks: Card[][],
	poolKeys: Set<string>
): LineWalkResult {
	if (admittedWalks.length === 0) {
		return { cards: [], walkStarts: [], walkFenKeys: [], dueOriginalKeys: new Set() };
	}

	const root: PrefixTrieNode = { card: null, count: 0, children: new Map() };
	for (const walk of admittedWalks) {
		let node = root;
		for (const c of walk) {
			let child = node.children.get(c.fenKey);
			if (!child) {
				child = { card: c, count: 0, children: new Map() };
				node.children.set(c.fenKey, child);
			}
			child.count += 1;
			node = child;
		}
	}

	const out: Card[] = [];
	const walkStarts: number[] = [];
	const walkFenKeys: Set<string>[] = [];
	const dueOriginalKeys = new Set<string>();

	const flushSegment = (seg: Card[]) => {
		if (seg.length === 0) return;
		const start = out.length;
		const fenSet = new Set<string>();
		for (const c of seg) {
			out.push(c);
			fenSet.add(c.fenKey);
			if (poolKeys.has(c.fenKey)) dueOriginalKeys.add(c.fenKey);
		}
		walkStarts.push(start);
		walkFenKeys.push(fenSet);
	};

	const visit = (node: PrefixTrieNode, accumulated: Card[]) => {
		const seg = node.card ? [...accumulated, node.card] : [...accumulated];
		const kids = [...node.children.values()];
		if (kids.length === 0) {
			flushSegment(seg);
			return;
		}
		if (kids.length === 1) {
			visit(kids[0], seg);
			return;
		}
		// Branching: emit the accumulated shared segment, then recurse
		// into each child branch with shared-first ordering.
		flushSegment(seg);
		kids.sort((a, b) => b.count - a.count);
		for (const child of kids) visit(child, []);
	};

	visit(root, []);
	return { cards: out, walkStarts, walkFenKeys, dueOriginalKeys };
}

/**
 * Apply line-first ordering + line-label assignment to a card list. When
 * `startFenKey` is set (train-from-position mode) the ordering re-anchors to
 * that sub-position instead of the repertoire root, so labels and line order
 * begin at the chosen branch rather than move one.
 */
function sortByLineOrder(
	cards: Card[],
	rep: Repertoire,
	nodes: Map<string, RepertoireNode>,
	applyOverdueCap: boolean,
	startFenKey?: string | null
): { cards: Card[]; lineLabelByKey: Map<string, string | null> } {
	const lineLabelByKey = new Map<string, string | null>();
	if (cards.length === 0) return { cards, lineLabelByKey };
	const anchor = startFenKey ?? rep.rootFenKey;
	const ordered = buildLineFirstQueue(cards, nodes, {
		rootFenKey: anchor,
		startingFenKey: startFenKey ?? rep.startingFenKey ?? null,
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
	options?: { includeIdeas?: boolean; startFenKey?: string | null }
): Promise<DrillSegment> {
	const nodes = await nodesMap(rep.id);
	// Train-from-position: only honour the anchor when it's actually a node in
	// this repertoire (guards against stale deep-links). An unknown key falls
	// back to a normal full-repertoire drill.
	const startFenKey =
		options?.startFenKey && nodes.has(options.startFenKey) ? options.startFenKey : null;
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
	const lineHead = startFenKey ?? rep.rootFenKey;
	// Train-from-position drills every prepared move in the chosen subtree
	// regardless of FSRS due date — an explicit "practice here now" request
	// would otherwise yield an empty session when nothing below is due.
	// Grading still updates FSRS as normal; only the selection ignores due.
	let pool: Card[];
	if (startFenKey) {
		const subtree = reachableFenKeys(nodes, startFenKey);
		pool = (await listCards(rep.id)).filter((c) => subtree.has(c.fenKey));
	} else {
		pool = await dueCards(rep.id, Date.now(), settings.drillSessionCap * 5);
	}
	const lineWalkOn = (settings.drillIntermediateMoves ?? 'play') === 'play';

	if (lineWalkOn) {
		const result = await pickWithLineWalk(
			pool,
			rep,
			nodes,
			settings,
			settings.drillSessionCap,
			settings.dailyNewCardCap,
			lineHead
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
	const sorted = sortByLineOrder(due, rep, nodes, true, startFenKey);
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

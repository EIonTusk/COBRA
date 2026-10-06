import { Rating } from 'ts-fsrs';
import type { AppSettings, Card, IdeaCard, Repertoire, RepertoireNode } from '$lib/types';
import { colorToMove } from '$lib/chess/fen';
import {
	pathToFenKey,
	plyDepths,
	reachableFenKeys,
	shortestPathTree,
	liveReachableFenKeys
} from '$lib/tree/traversal';
import { buildLineFirstQueue } from '$lib/tree/lineOrder';
import { reachProbabilities } from '$lib/tree/reachProbability';
import { getCard, listCards, mistakeCards, pickBalancedDueCards } from '$lib/storage/cards';
import { dueIdeaCards } from '$lib/storage/ideaCards';
import { filterActiveMistakes, listMistakes } from '$lib/storage/mistakes';
import { createFreshCard } from '$lib/fsrs/scheduler';
import { nodesMap } from '$lib/storage/nodes';
import { forcedRuns, runAfter, runBefore, type ForcedRuns } from './forcedLines';
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

/**
 * Path from the line head to `fenKey`, preferring live (non-disabled) edges
 * so a line walk never routes through a shelved move when a transposition
 * reaches the same position through a live line. Falls back to the plain
 * shortest path when no live route exists.
 */
function linePath(nodes: Map<string, RepertoireNode>, lineHead: string, fenKey: string) {
	return (
		pathToFenKey(nodes, lineHead, fenKey, { skipDisabled: true }) ??
		pathToFenKey(nodes, lineHead, fenKey)
	);
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
	lineHead: string,
	isTrainable: (c: Card) => boolean,
	runs: ForcedRuns,
	withinDepth: (c: Card) => boolean
): Promise<LineWalkResult> {
	const wellLearnedDays = settings.drillWellLearnedDays ?? 7;

	const depthByKey = new Map<string, number>();
	for (const c of pool) {
		if (depthByKey.has(c.fenKey)) continue;
		const path = linePath(nodes, lineHead, c.fenKey);
		depthByKey.set(c.fenKey, path ? path.length : -1);
	}
	// Reviews claim the budget before new cards (as in pickBalancedDueCards),
	// then depth-ASC within each: shallower candidates first so the
	// trunk-extraction step emits shallow shared segments before deep tails,
	// mirroring how a human builds a repertoire. Without the review-first
	// split, breadth-first new cards — always the shallowest — outbid deeper
	// due reviews every session and let them pile up overdue. Admission
	// order only decides what fits the budget; emission order comes from the
	// trie below.
	// New cards keep the order the pool was built in: orderNewCards already
	// ranked them (most likely to be reached first, then shallowest).
	const poolRank = new Map<string, number>();
	pool.forEach((c, i) => {
		if (!poolRank.has(c.fenKey)) poolRank.set(c.fenKey, i);
	});
	const sortedPool = pool.slice().sort((a, b) => {
		const nA = a.lastReview ? 0 : 1;
		const nB = b.lastReview ? 0 : 1;
		if (nA !== nB) return nA - nB;
		if (nA === 1) return poolRank.get(a.fenKey)! - poolRank.get(b.fenKey)!;
		const dA = depthByKey.get(a.fenKey) ?? -1;
		const dB = depthByKey.get(b.fenKey) ?? -1;
		if (dA !== dB) return dA - dB;
		return a.dueAt - b.dueAt;
	});

	const poolKeys = new Set<string>();
	const poolByKey = new Map<string, Card>();
	for (const c of pool) {
		poolKeys.add(c.fenKey);
		if (!poolByKey.has(c.fenKey)) poolByKey.set(c.fenKey, c);
	}

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
		// Forced runs (issue #86) are drilled whole: the earlier moves of the
		// candidate's run join the walk even when well-learned, and the rest
		// of the run follows it.
		const runHead = new Set(runBefore(runs, candidate.fenKey));
		if (candidate.fenKey !== lineHead) {
			const path = linePath(nodes, lineHead, candidate.fenKey);
			if (path) {
				for (let i = 0; i < path.length; i++) {
					const fenKeyBeforeEdge = i === 0 ? lineHead : path[i - 1].toFenKey;
					if (fenKeyBeforeEdge === candidate.fenKey) break;
					if (colorToMove(fenKeyBeforeEdge) !== rep.color) continue;
					const stored = await getCard(rep.id, fenKeyBeforeEdge);
					if (!stored) continue;
					// Prefix steps obey the same disabled-line filter as the
					// pool (issue #91): the card at a prefix position may
					// expect a move the user has disabled.
					if (!isTrainable(stored)) continue;
					if (isWellLearned(stored, wellLearnedDays) && !runHead.has(fenKeyBeforeEdge)) continue;
					walk.push(stored);
				}
			}
		}
		walk.push(candidate);
		const suffix: Card[] = [];
		for (const k of runAfter(runs, candidate.fenKey)) {
			const stored = poolByKey.get(k) ?? (await getCard(rep.id, k));
			// A move the drill wouldn't offer ends the run: disabled, past the
			// training depth, or new and not yet unlocked (new cards in the
			// pool are the unlocked ones).
			if (!stored || !isTrainable(stored) || !withinDepth(stored)) break;
			if (!stored.lastReview && !poolKeys.has(k)) break;
			suffix.push(stored);
		}

		// Budget the walk at its INCREMENTAL cost — the cards it adds that no
		// already-admitted walk covers. Trunk extraction emits a shared run
		// once, as its own walk, so charging each candidate for the full path
		// back to the head billed the same trunk moves once per descendant:
		// five lines sharing a six-move trunk were charged 30 events for the
		// six the user actually plays. On a large repertoire (deep lines, heavy
		// sharing) that over-charge consumed the whole session cap on moves
		// that were never emitted, which is why a big due queue barely moved.
		const cost = (cards: Card[]) => {
			const incremental = cards.filter((c) => !admittedFenKeys.has(c.fenKey));
			const newCount = incremental.reduce(
				(sum, c) => sum + (!c.lastReview && !uniqueNewSeen.has(c.fenKey) ? 1 : 0),
				0
			);
			const hasNew = incremental.some((c) => !c.lastReview);
			return { events: incremental.length * (hasNew ? 2 : 1), newCount };
		};
		const base = cost(walk);
		if (base.events > totalRemaining) continue;
		if (base.newCount > newRemaining) continue;
		// The forced run's tail rides along when it fits the session. Its new
		// moves count as one introduction with the move that starts the run:
		// they may overshoot the new-move budget (as long as any is left), or
		// a run longer than the daily budget would never unlock.
		let { events: eventCost, newCount: newInWalk } = base;
		if (suffix.length > 0) {
			const full = cost([...walk, ...suffix]);
			const newOk = full.newCount === base.newCount || newRemaining > 0;
			if (full.events <= totalRemaining && newOk) {
				walk.push(...suffix);
				eventCost = full.events;
				newInWalk = full.newCount;
			}
		}

		ledBy.add(candidate.fenKey);
		for (const c of walk) {
			admittedFenKeys.add(c.fenKey);
			if (!c.lastReview) uniqueNewSeen.add(c.fenKey);
		}
		admittedWalks.push(walk);
		totalRemaining -= eventCost;
		newRemaining = Math.max(0, newRemaining - newInWalk);
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
 * Soft-disabled lines drop out of the trainable set (issue #80). A card at
 * position P is trainable only when P is still reachable through non-disabled
 * edges AND P's own prepared move isn't the disabled head — the card lives at
 * the parent, so live-reachability alone wouldn't skip a move disabled
 * directly at P (P stays reachable from above).
 *
 * Exported so the runner can apply the same rule when it chains into the
 * next card of a line mid-session.
 */
export function trainableFilter(
	rep: Repertoire,
	nodes: Map<string, RepertoireNode>
): (c: Card) => boolean {
	const live = liveReachableFenKeys(nodes, rep.rootFenKey);
	return (c) => {
		if (!live.has(c.fenKey)) return false;
		const edge = nodes.get(c.fenKey)?.children.find((e) => e.san === c.expectedSan);
		return !edge?.disabled;
	};
}

/**
 * Training-depth predicate (issue #86): keep only cards whose move falls
 * within the first `maxMoves` full moves of its line, numbered from the
 * repertoire's root position (the root's own move is move 1; if black is to
 * move at the root, black's first reply is still move 1). A transposed
 * position uses its shallowest route. Unreachable cards are dropped. Falsy /
 * non-positive `maxMoves` = no limit.
 *
 * Exported for unit testing.
 */
export function depthFilter(
	rep: Repertoire,
	nodes: Map<string, RepertoireNode>,
	maxMoves: number | null | undefined
): (c: Card) => boolean {
	if (!maxMoves || !Number.isFinite(maxMoves) || maxMoves <= 0) return () => true;
	const depths = plyDepths(nodes, rep.rootFenKey);
	const offset = colorToMove(rep.rootFenKey) === 'white' ? 0 : 1;
	return (c) => {
		const ply = depths.get(c.fenKey);
		if (ply === undefined) return false;
		return Math.floor((ply + offset) / 2) + 1 <= maxMoves;
	};
}

/**
 * Fallback for cards graded before `lastRating` was recorded: stability
 * (days) below which the last recall is taken to have failed. With
 * short-term steps off, FSRS never enters the Relearning state, and a miss
 * on a young card leaves ~0.2–0.6d while any pass lands at 2d or more.
 */
const SHAKY_STABILITY_DAYS = 1;

/**
 * An introduced card whose last recall failed. Descendants' new moves wait
 * until it's recalled again (progressive unlock, issue #86).
 */
export function isShaky(card: Card): boolean {
	if (card.lastRating !== undefined) return card.lastRating === Rating.Again;
	const stability = typeof card.fsrs.stability === 'number' ? card.fsrs.stability : 0;
	return stability < SHAKY_STABILITY_DAYS;
}

/**
 * Order never-introduced cards for the drill pool. With `reach` (the
 * "prioritise common lines" setting), most likely to be reached first —
 * see reachProbabilities; a parent is always at least as likely as its
 * children, so lines still unlock top-down. Then shallowest first across the
 * whole tree (ply depth from the root), then import order. With
 * `progressive` on (issue #86), a new card is only offered once every
 * earlier user move on its shortest line is ready — introduced and its
 * last recall didn't fail (see isShaky), or itself a new card offered ahead of it in this same ordering (so
 * a fresh line still unlocks move by move within one session, with the
 * line walk teaching the parent first). Forgetting an early move therefore
 * pauses new material beneath it until it's recalled again.
 *
 * New ancestors outside `fresh` (not trainable — e.g. a disabled line)
 * don't block. Exported for unit testing; pure.
 */
export function orderNewCards(
	fresh: Card[],
	cardByKey: Map<string, Card>,
	tree: { depth: Map<string, number>; parent: Map<string, string> },
	progressive: boolean,
	reach?: Map<string, number>,
	runs?: ForcedRuns
): Card[] {
	const depthOf = (c: Card) => tree.depth.get(c.fenKey) ?? Infinity;
	const reachOf = (c: Card) => reach?.get(c.fenKey) ?? 0;
	const sorted = fresh.slice().sort((a, b) => {
		if (reach) {
			const ra = reachOf(a);
			const rb = reachOf(b);
			// Relative tolerance: equal-by-construction products can differ
			// in the last bits depending on multiplication order.
			if (Math.abs(ra - rb) > 1e-9 * Math.max(ra, rb)) return rb - ra;
		}
		return depthOf(a) - depthOf(b) || a.dueAt - b.dueAt;
	});
	if (!progressive) return groupForcedRuns(sorted, runs);

	const freshKeys = new Set(fresh.map((c) => c.fenKey));
	const unlocked = new Set<string>();
	const pathReady = (fenKey: string): boolean => {
		for (let k = tree.parent.get(fenKey); k !== undefined; k = tree.parent.get(k)) {
			const anc = cardByKey.get(k);
			if (!anc) continue;
			if (anc.lastReview) {
				if (isShaky(anc)) return false;
			} else if (freshKeys.has(k) && !unlocked.has(k)) {
				return false;
			}
		}
		return true;
	};
	const out: Card[] = [];
	for (const c of sorted) {
		if (!pathReady(c.fenKey)) continue;
		unlocked.add(c.fenKey);
		out.push(c);
	}
	return groupForcedRuns(out, runs);
}

/**
 * Keep each forced run's new moves together (issue #86): a run member whose
 * predecessor in the run is also in `cards` moves up to right after it, so
 * the run unlocks — and fits the session budget — as one unit. Pure.
 */
export function groupForcedRuns(cards: Card[], runs?: ForcedRuns): Card[] {
	if (!runs || runs.next.size === 0) return cards;
	const byKey = new Map(cards.map((c) => [c.fenKey, c]));
	const out: Card[] = [];
	const placed = new Set<string>();
	for (const c of cards) {
		if (placed.has(c.fenKey)) continue;
		const prev = runs.prev.get(c.fenKey);
		if (prev !== undefined && byKey.has(prev)) continue; // emitted after prev
		out.push(c);
		placed.add(c.fenKey);
		for (const k of runAfter(runs, c.fenKey)) {
			const f = byKey.get(k);
			if (!f || placed.has(k)) break;
			out.push(f);
			placed.add(k);
		}
	}
	// A member whose predecessor was dropped above (can't happen for a
	// well-formed run, but never lose a card).
	for (const c of cards) if (!placed.has(c.fenKey)) out.push(c);
	return out;
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
	// Every mode honours soft-disabled lines (issues #80, #91).
	const isTrainable = trainableFilter(rep, nodes);
	const includeIdeas = options?.includeIdeas ?? mode === 'due';
	let ideaQueue: IdeaCard[] = [];
	if (includeIdeas && mode === 'due') {
		// Idea cards are position prompts, not moves: drop the ones only
		// reachable through a disabled line.
		const live = liveReachableFenKeys(nodes, rep.rootFenKey);
		ideaQueue = (await dueIdeaCards(rep.id, Date.now(), settings.drillSessionCap)).filter((c) =>
			live.has(c.fenKey)
		);
	}

	if (mode === 'mistakes') {
		const cards = (await mistakeCards(rep.id, Number.MAX_SAFE_INTEGER))
			.filter(isTrainable)
			.slice(0, settings.drillSessionCap);
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
			const card = existing ?? createFreshCard(rep.id, m.fenKey, m.expectedSan, Date.now());
			if (isTrainable(card)) cards.push(card);
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
	const withinDepth = depthFilter(rep, nodes, rep.drillMaxMoves);
	const runs = forcedRuns(nodes, rep.rootFenKey, rep.color);
	let pool: Card[];
	const reach =
		settings.drillPrioritizeCommon !== false
			? reachProbabilities(nodes, rep.rootFenKey, rep.color)
			: undefined;
	if (startFenKey) {
		const subtree = reachableFenKeys(nodes, startFenKey);
		const all = await listCards(rep.id);
		const inScope = all.filter((c) => subtree.has(c.fenKey) && isTrainable(c) && withinDepth(c));
		pool = [
			...inScope.filter((c) => c.lastReview).sort((a, b) => a.dueAt - b.dueAt),
			...orderNewCards(
				inScope.filter((c) => !c.lastReview),
				new Map(all.map((c) => [c.fenKey, c])),
				shortestPathTree(nodes, rep.rootFenKey),
				false,
				reach,
				runs
			)
		];
	} else {
		// Reviews and new cards are pooled separately (issue #86). A single
		// dueAt-ordered window let never-introduced cards — due since import,
		// so older than any review — crowd reviews out entirely, and since PGN
		// import seeds cards line by line, the new cards in that window were
		// "the first N cards of the PGN": deep moves of the first lines ahead
		// of the first move of later ones. New cards are instead ranked across
		// the whole tree (most likely to be reached, then shallowest first),
		// then gated on their path.
		const now = Date.now();
		const poolCap = settings.drillSessionCap * 5;
		const all = await listCards(rep.id);
		const due = all
			.filter((c) => c.dueAt <= now && isTrainable(c) && withinDepth(c))
			.sort((a, b) => a.dueAt - b.dueAt);
		const reviews = due.filter((c) => c.lastReview).slice(0, poolCap);
		const fresh = orderNewCards(
			due.filter((c) => !c.lastReview),
			new Map(all.map((c) => [c.fenKey, c])),
			shortestPathTree(nodes, rep.rootFenKey),
			rep.progressiveUnlock !== false,
			reach,
			runs
		).slice(0, poolCap);
		pool = [...reviews, ...fresh];
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
			lineHead,
			isTrainable,
			runs,
			withinDepth
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
	// Forced runs (issue #86) come whole: add the rest of each picked card's
	// run (already-introduced moves only — new ones need the line walk to be
	// taught). They grade as line-walk steps, outside `dueOriginalKeys`.
	const picked = new Set(dueOriginalKeys);
	const scope = startFenKey ? reachableFenKeys(nodes, startFenKey) : null;
	for (const c of [...due]) {
		for (const k of [...runBefore(runs, c.fenKey), ...runAfter(runs, c.fenKey)]) {
			if (picked.has(k) || (scope && !scope.has(k))) continue;
			const stored = await getCard(rep.id, k);
			if (!stored?.lastReview || !isTrainable(stored) || !withinDepth(stored)) continue;
			picked.add(k);
			due.push(stored);
		}
	}
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
 * Leaf cards the runner's leaves cycle may replay: already-introduced (a
 * second pass over moves never taught would ask them unhinted, bypassing the
 * new-card cap and progressive unlock), in a line that isn't disabled, and
 * within the rep's training depth — the same limits a `due` drill applies.
 */
export async function collectReplayLeafCards(
	rep: Repertoire,
	nodes: Map<string, RepertoireNode>
): Promise<Card[]> {
	const isTrainable = trainableFilter(rep, nodes);
	const withinDepth = depthFilter(rep, nodes, rep.drillMaxMoves);
	return (await collectLeafCards(rep, nodes)).filter(
		(c) => !!c.lastReview && isTrainable(c) && withinDepth(c)
	);
}

/**
 * Cards whose user-move position has no deeper user-move card in the
 * repertoire — the "tips" of every prepared line. The runner's leaves cycle
 * replays these (via collectReplayLeafCards) as an extra second pass over a
 * segment's deepest moves.
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

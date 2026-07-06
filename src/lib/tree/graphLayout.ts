import type { RepertoireNode } from '$lib/types';

/**
 * A position placed on the graph canvas. `ply` is the column (shortest
 * discovery depth from the root); `row` is the vertical slot in layout units
 * — leaves take whole rows and a parent centres on the span of its children,
 * the classic tidy-tree assignment.
 */
export interface GraphNode {
	fenKey: string;
	ply: number;
	row: number;
	isRoot: boolean;
	/** Has tree-children, so it can be collapsed (or expanded). */
	hasChildren: boolean;
	/** Currently collapsed: its subtree is hidden and drawn as this one node. */
	collapsed: boolean;
	/** Number of descendants hidden while collapsed (0 when expanded). */
	hiddenCount: number;
}

/**
 * A move between two placed positions. `transposition` marks an edge whose
 * target is drawn elsewhere (a shared position reached by another move order,
 * or a back edge from a repetition) rather than this edge's own tree child —
 * the renderer draws those as secondary links so the primary tree stays clean.
 */
export interface GraphEdge {
	fromFenKey: string;
	toFenKey: string;
	san: string;
	uci: string;
	disabled: boolean;
	transposition: boolean;
}

export interface GraphLayout {
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** Largest ply reached — the number of columns is `maxPly + 1`. */
	maxPly: number;
	/** Total rows consumed — the canvas height in row units. */
	rows: number;
	/** True only when the `maxNodes` safety cap was actually hit and some
	 *  reachable positions were left unplaced (not merely orphan store rows). */
	capped: boolean;
}

export interface GraphLayoutOptions {
	/**
	 * Safety cap on placed positions — a backstop against a pathological graph,
	 * not a normal limit. Layout itself is cheap (O(nodes+edges)) and the page
	 * culls to the viewport, so this is set high enough that real repertoires
	 * are never truncated. Default 20000.
	 */
	maxNodes?: number;
	/**
	 * Reorder sibling lines to pull transposition-linked positions vertically
	 * close, so those links stay short instead of sweeping across the graph.
	 * Only accepted when it strictly shortens the links, so it never makes the
	 * layout worse. Default true. (Skipped past ~1200 nodes for cost.)
	 */
	reorderTranspositions?: boolean;
	/**
	 * Positions whose subtree is collapsed: the node is still drawn, but its
	 * tree-children (and everything below) are hidden and it lays out as a leaf.
	 */
	collapsed?: Set<string>;
}

/** Above this node count the reorder pass is skipped — the graph is scanned
 *  zoomed out there, and the O(nodes) re-layout per trial would add up. */
const REORDER_MAX_NODES = 1200;
const REORDER_MAX_PASSES = 8;

/**
 * Lay the FEN-keyed repertoire graph out as a left-to-right tidy tree, one box
 * per unique position. Columns are plies from the root; rows come from a
 * mainline-first DFS so siblings stack and each parent sits centred on its
 * children. Sibling lines are then reordered (greedily, only when it helps) to
 * shorten transposition links — see `reorderTranspositions`.
 *
 * Positions dedup by fenKey, so a subtree reached by several move orders is
 * placed once (at its first, mainline discovery) and the extra arrivals become
 * `transposition` edges. That also makes the walk cycle-safe: a back edge to an
 * already-visited position is recorded as a link, never re-entered.
 */
export function buildGraphLayout(
	nodes: Map<string, RepertoireNode>,
	rootFenKey: string,
	opts: GraphLayoutOptions = {}
): GraphLayout {
	const maxNodes = opts.maxNodes ?? 20000;
	const doReorder = opts.reorderTranspositions ?? true;
	const collapsed = opts.collapsed ?? new Set<string>();

	// ── Phase A: discover the tree structure + all edges (mainline-first) ──
	// `treeChildren` holds each node's ordered tree-children; that ordering is
	// the only thing we tune below (plies/edges are fixed).
	const treeChildren = new Map<string, string[]>();
	const plyByKey = new Map<string, number>();
	const rawEdges: GraphEdge[] = [];
	const visited = new Set<string>();
	let capped = false;

	function discover(fenKey: string, ply: number) {
		visited.add(fenKey);
		plyByKey.set(fenKey, ply);
		const kids: string[] = [];
		for (const edge of nodes.get(fenKey)?.children ?? []) {
			const isNew = !visited.has(edge.toFenKey);
			if (isNew && plyByKey.size < maxNodes) {
				kids.push(edge.toFenKey);
				discover(edge.toFenKey, ply + 1);
			} else if (isNew) {
				capped = true; // reachable but over the safety cap
			}
			rawEdges.push({
				fromFenKey: fenKey,
				toFenKey: edge.toFenKey,
				san: edge.san,
				uci: edge.uci,
				disabled: !!edge.disabled,
				transposition: !isNew
			});
		}
		treeChildren.set(fenKey, kids);
	}

	if (nodes.size > 0) discover(rootFenKey, 0);

	if (plyByKey.size === 0) {
		return { nodes: [], edges: [], maxPly: 0, rows: 1, capped: false };
	}

	// Descendant counts over the full tree — how many positions a collapse hides.
	const descCount = new Map<string, number>();
	(function count(k: string): number {
		let n = 0;
		for (const c of treeChildren.get(k) ?? []) n += 1 + count(c);
		descCount.set(k, n);
		return n;
	})(rootFenKey);

	// Collapse-aware children + the visible node set (everything not under a
	// collapsed ancestor). All layout below walks `childrenOf`, so a collapsed
	// node lays out as a leaf.
	const childrenOf = (k: string): string[] => (collapsed.has(k) ? [] : (treeChildren.get(k) ?? []));
	const visible = new Set<string>();
	(function markVisible(k: string) {
		visible.add(k);
		for (const c of childrenOf(k)) markVisible(c);
	})(rootFenKey);

	let maxPly = 0;
	for (const k of visible) maxPly = Math.max(maxPly, plyByKey.get(k) ?? 0);

	const edges = rawEdges.filter((e) => visible.has(e.fromFenKey) && visible.has(e.toFenKey));
	const transEdges = edges.filter((e) => e.transposition);

	// ── Phase B: assign rows for the current child ordering ──
	// Leaves take consecutive rows; parents centre on the span of their
	// children. Returns the row map; `leafCount` (structural, ordering-
	// independent) doubles as the canvas height in rows.
	let leafCount = 0;
	function assignRows(): Map<string, number> {
		const rowByKey = new Map<string, number>();
		leafCount = 0;
		function place(fenKey: string): number {
			const kids = childrenOf(fenKey);
			let row: number;
			if (kids.length > 0) {
				let mn = Infinity;
				let mx = -Infinity;
				for (const c of kids) {
					const r = place(c);
					if (r < mn) mn = r;
					if (r > mx) mx = r;
				}
				row = (mn + mx) / 2;
			} else {
				row = leafCount++;
			}
			rowByKey.set(fenKey, row);
			return row;
		}
		place(rootFenKey);
		return rowByKey;
	}

	let rowByKey = assignRows();

	// ── Phase C: greedily reorder sibling lines to shorten transposition links ──
	if (doReorder && transEdges.length > 0 && plyByKey.size <= REORDER_MAX_NODES) {
		const partners = new Map<string, string[]>();
		const addPartner = (a: string, b: string) => {
			const list = partners.get(a);
			if (list) list.push(b);
			else partners.set(a, [b]);
		};
		for (const e of transEdges) {
			addPartner(e.fromFenKey, e.toFenKey);
			addPartner(e.toFenKey, e.fromFenKey);
		}

		// A node is "relevant" if its subtree contains a transposition endpoint;
		// reordering anywhere else can't change link length, so we skip it.
		const relevant = new Set<string>();
		(function mark(fenKey: string): boolean {
			let rel = partners.has(fenKey);
			for (const c of childrenOf(fenKey)) if (mark(c)) rel = true;
			if (rel) relevant.add(fenKey);
			return rel;
		})(rootFenKey);

		const totalLinkLength = (rows: Map<string, number>) => {
			let sum = 0;
			for (const e of transEdges) {
				sum += Math.abs((rows.get(e.fromFenKey) ?? 0) - (rows.get(e.toFenKey) ?? 0));
			}
			return sum;
		};

		// Barycentre of a subtree's transposition partners; null when it has
		// none (then the child keeps its current row as a stable sort key).
		function partnerBarycentre(fenKey: string, rows: Map<string, number>): number | null {
			let sum = 0;
			let count = 0;
			const stack = [fenKey];
			while (stack.length > 0) {
				const k = stack.pop()!;
				for (const p of partners.get(k) ?? []) {
					sum += rows.get(p) ?? 0;
					count += 1;
				}
				for (const c of childrenOf(k)) stack.push(c);
			}
			return count > 0 ? sum / count : null;
		}

		const parents = [...visible].filter((k) => relevant.has(k) && childrenOf(k).length >= 2);

		let curCost = totalLinkLength(rowByKey);
		let improved = true;
		let pass = 0;
		while (improved && pass < REORDER_MAX_PASSES) {
			improved = false;
			pass += 1;
			for (const parent of parents) {
				const cur = treeChildren.get(parent)!;
				// Sort children by their subtree's pull toward partner rows;
				// pull-less children fall back to their current row, so they
				// hold position (stable) while linked lines migrate.
				const cand = cur
					.map((c, i) => ({ c, i, key: partnerBarycentre(c, rowByKey) ?? rowByKey.get(c) ?? 0 }))
					.sort((a, b) => a.key - b.key || a.i - b.i)
					.map((x) => x.c);
				if (cand.every((c, i) => c === cur[i])) continue;
				treeChildren.set(parent, cand);
				const trialRows = assignRows();
				const trialCost = totalLinkLength(trialRows);
				if (trialCost < curCost) {
					curCost = trialCost;
					rowByKey = trialRows;
					improved = true;
				} else {
					treeChildren.set(parent, cur); // revert — never accept a regression
				}
			}
		}
	}

	const out = [...visible]
		.map((k) => {
			const hasChildren = (treeChildren.get(k)?.length ?? 0) > 0;
			const isCollapsed = hasChildren && collapsed.has(k);
			return {
				fenKey: k,
				ply: plyByKey.get(k) ?? 0,
				row: rowByKey.get(k) ?? 0,
				isRoot: k === rootFenKey,
				hasChildren,
				collapsed: isCollapsed,
				hiddenCount: isCollapsed ? (descCount.get(k) ?? 0) : 0
			};
		})
		.sort((a, b) => a.ply - b.ply || a.row - b.row);
	return { nodes: out, edges, maxPly, rows: Math.max(leafCount, 1), capped };
}

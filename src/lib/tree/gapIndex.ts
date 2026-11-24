/**
 * The builder's gap search: opponent moves that clear the repertoire's
 * "1 in N" threshold (games >= rootTotal / goal) but have no edge in the tree.
 * Backs the three entries of the edit page's "Find gap" menu:
 *
 *   - `nextOnLine`  — "Next gap on this line": the earliest gap from the root
 *     down to the board position (closest to the root wins), and if the line
 *     is clean, the biggest gap in the subtree below the board position.
 *   - `biggest` with `exclude` = the current line — "Biggest gap off this line".
 *   - `biggest` — "Biggest gap overall".
 *
 * Rate-limit efficiency is the point of this module (Lichess limits the
 * explorer hard, #88):
 *
 *   - Best-first search. Opponent positions are expanded from a max-heap
 *     keyed by how many games reach them. A gap at a position can't have more
 *     games than the position itself, so the search stops as soon as the best
 *     gap found beats everything left in the heap, and never probes a
 *     position whose games are below the threshold (no gap there can count).
 *     Bounds come from explorer data already in hand: the parent's response,
 *     the stored `Edge.frequency` totals, or the explorer's in-memory cache.
 *     User-to-move positions are never probed.
 *   - One explorer answer per position for the life of the index. The search
 *     reads the tree afresh on every query, so saving a line, disabling a
 *     move or importing a PGN costs no rescan: the next query just walks the
 *     new tree over the stats it already has.
 *   - Probes accept persisted explorer rows up to `MAX_STALE_MS` old, so a
 *     reload, or reopening the repertoire next week, answers from IndexedDB.
 *
 * Exactness: with transpositions a position can be reached by more games than
 * the move leading into it from inside the tree, so a bound can undershoot.
 * The search then still returns a real gap, but in rare cases not the very
 * largest one. Without transpositions the answer is exact.
 */

import { parseFen, makeFen } from 'chessops/fen';
import { Chess } from 'chessops/chess';
import { parseUci } from 'chessops/util';

import { colorToMove } from '$lib/chess/fen';
import {
	fetchExplorer,
	peekExplorer,
	MAX_STALE_MS,
	type ExplorerQuery,
	type ExplorerResponse,
	type FetchOptions
} from '$lib/explorer/client';
import { liveMoves } from '$lib/tree/liveMoves';
import type { MissingMove } from '$lib/tree/missing';
import type { Color, RepertoireNode } from '$lib/types';

/** Moves asked per position; matches the explorer client's shared size. */
const PROBE_MOVES = 30;

export interface GapIndexConfig {
	rootFenKey: string;
	rootFen: string;
	color: Color;
	token: string;
	speeds?: string[];
	ratings?: number[];
	/** The tree as it is now; read on every query. */
	getNodes: () => Map<string, RepertoireNode>;
	/**
	 * Moves played on the board but not saved yet. They count as covered so
	 * a gap the user is answering right now isn't suggested again.
	 */
	getPending?: () => Iterable<{ fromKey: string; uci: string }>;
}

export interface GapQueryOpts {
	/** Checked between probes: an aborted query stops without probing more. */
	signal?: AbortSignal;
	/**
	 * Explorer priority for this query's probes. `foreground` when the user
	 * is waiting on the answer (an open menu, a click); default `background`.
	 */
	priority?: 'foreground' | 'background';
}

interface PositionStats {
	total: number;
	moves: { uci: string; san: string; games: number }[];
}

interface Frontier {
	fenKey: string;
	/** Upper estimate of the games reaching this position. */
	bound: number;
	depth: number;
}

/** Explorer requests are injectable for tests. */
export interface GapIndexDeps {
	fetch: (q: ExplorerQuery, o: FetchOptions) => Promise<ExplorerResponse>;
	peek: (q: ExplorerQuery) => ExplorerResponse | null;
}

export function fenFromKey(key: string): string {
	return key.split(' ').length === 4 ? `${key} 0 1` : key;
}

export class GapIndex {
	private readonly cfg: GapIndexConfig;
	private readonly deps: GapIndexDeps;
	private readonly stats = new Map<string, PositionStats>();
	private readonly inflight = new Map<string, Promise<PositionStats>>();
	/** Explorer calls this index made (cache hits included). For tests. */
	probes = 0;

	constructor(cfg: GapIndexConfig, deps?: Partial<GapIndexDeps>) {
		this.cfg = cfg;
		this.deps = { fetch: deps?.fetch ?? fetchExplorer, peek: deps?.peek ?? peekExplorer };
	}

	/** Threshold for a goal, from the root's game count (one probe, once). */
	async threshold(goal: number, opts: GapQueryOpts = {}): Promise<number | null> {
		if (goal <= 0) return null;
		throwIfAborted(opts.signal);
		const root = await this.probe(this.cfg.rootFenKey, opts.priority);
		return root.total > 0 ? root.total / goal : null;
	}

	/**
	 * The most-played gap in the live tree, optionally ignoring gaps at the
	 * positions in `exclude`.
	 */
	async biggest(
		goal: number,
		opts: GapQueryOpts & { exclude?: ReadonlySet<string> } = {}
	): Promise<MissingMove | null> {
		const threshold = await this.threshold(goal, opts);
		if (threshold === null) return null;
		const exclude = opts.exclude;
		const root = this.stats.get(this.cfg.rootFenKey)!;
		return this.search(
			[{ fenKey: this.cfg.rootFenKey, bound: root.total, depth: 0 }],
			threshold,
			exclude ? (k) => !exclude.has(k) : () => true,
			opts
		);
	}

	/**
	 * "Next gap on this line": walk `path` (root first, board position last)
	 * and return the most-played gap at the first opponent position that has
	 * one. The walk stops at a disabled move (#99). If the line is clean up to
	 * the board, return the biggest gap in the live subtree below the board
	 * position instead.
	 */
	async nextOnLine(
		goal: number,
		path: readonly string[],
		opts: GapQueryOpts = {}
	): Promise<MissingMove | null> {
		if (path.length === 0) return null;
		const threshold = await this.threshold(goal, opts);
		if (threshold === null) return null;
		const nodes = this.cfg.getNodes();
		let bound = this.stats.get(this.cfg.rootFenKey)!.total;
		for (let i = 0; i < path.length; i++) {
			const fenKey = path[i];
			const node = nodes.get(fenKey);
			if (!node) return null;
			if (bound < threshold) return null; // nothing further down can count
			const theirs = colorToMove(fenKey) !== this.cfg.color;
			let stats: PositionStats | null;
			if (theirs) {
				const own = storedTotal(node);
				if (own !== undefined && own < threshold) return null; // the line is done
				throwIfAborted(opts.signal);
				stats = await this.probe(fenKey, opts.priority);
				const gap = this.bestGapAt(node, stats, threshold, i);
				if (gap) return gap;
			} else {
				stats = this.known(fenKey);
			}
			if (i === path.length - 1) {
				return this.search(
					[{ fenKey, bound, depth: i }],
					threshold,
					(k) => k !== fenKey || !theirs,
					opts
				);
			}
			const via = node.children.find((e) => e.toFenKey === path[i + 1]);
			if (!via || via.disabled) return null;
			bound = stats ? gamesOf(stats, via.uci) : bound;
		}
		return null;
	}

	/**
	 * Best-first search from `start`. `accept(fenKey)` filters which
	 * positions' gaps may be returned (positions still get expanded).
	 */
	private async search(
		start: Frontier[],
		threshold: number,
		accept: (fenKey: string) => boolean,
		{ signal, priority }: GapQueryOpts
	): Promise<MissingMove | null> {
		const nodes = this.cfg.getNodes();
		const heap = new MaxHeap<Frontier>((f) => f.bound);
		for (const f of start) heap.push(f);
		const done = new Set<string>();
		let best: MissingMove | null = null;
		while (heap.size > 0) {
			const top = heap.pop()!;
			if (done.has(top.fenKey)) continue;
			if (top.bound < threshold) break;
			if (best && best.games >= top.bound) break;
			done.add(top.fenKey);
			const node = nodes.get(top.fenKey);
			if (!node) continue;
			const theirs = colorToMove(top.fenKey) !== this.cfg.color;
			let stats: PositionStats | null;
			if (theirs) {
				throwIfAborted(signal);
				stats = await this.probe(top.fenKey, priority);
				if (accept(top.fenKey)) {
					const gap = this.bestGapAt(node, stats, threshold, top.depth);
					if (gap && (!best || gap.games > best.games)) best = gap;
				}
			} else {
				stats = this.known(top.fenKey);
			}
			for (const edge of liveMoves(node)) {
				if (done.has(edge.toFenKey)) continue;
				const child = nodes.get(edge.toFenKey);
				let bound = stats ? gamesOf(stats, edge.uci) : top.bound;
				// An opponent position's own stored total is the better figure.
				const own =
					child && colorToMove(edge.toFenKey) !== this.cfg.color ? storedTotal(child) : undefined;
				if (own !== undefined) bound = own;
				heap.push({ fenKey: edge.toFenKey, bound, depth: top.depth + 1 });
			}
		}
		return best;
	}

	private bestGapAt(
		node: RepertoireNode,
		stats: PositionStats,
		threshold: number,
		depth: number
	): MissingMove | null {
		const covered = new Set(node.children.map((e) => e.uci));
		for (const p of this.cfg.getPending?.() ?? []) {
			if (p.fromKey === node.fenKey) covered.add(p.uci);
		}
		let pick: PositionStats['moves'][number] | null = null;
		for (const m of stats.moves) {
			if (m.games < threshold || covered.has(m.uci)) continue;
			if (!pick || m.games > pick.games) pick = m;
		}
		if (!pick) return null;
		const fromFen = fenFromKey(node.fenKey);
		const afterFenKey = applyUci(fromFen, pick.uci);
		if (!afterFenKey) return null;
		return {
			fromFenKey: node.fenKey,
			fromFen,
			uci: pick.uci,
			san: pick.san,
			games: pick.games,
			positionGames: stats.total,
			afterFenKey,
			depth
		};
	}

	private query(fenKey: string): ExplorerQuery {
		return {
			fen: fenFromKey(fenKey),
			speeds: this.cfg.speeds,
			ratings: this.cfg.ratings,
			token: this.cfg.token,
			moves: PROBE_MOVES
		};
	}

	/** Stats already in hand: ours, or the explorer client's memory. Free. */
	private known(fenKey: string): PositionStats | null {
		const mine = this.stats.get(fenKey);
		if (mine) return mine;
		const res = this.deps.peek(this.query(fenKey));
		if (!res) return null;
		const s = toStats(res);
		this.stats.set(fenKey, s);
		return s;
	}

	/** Stats for a position, probing the explorer at most once per position. */
	private probe(
		fenKey: string,
		priority: 'foreground' | 'background' = 'background'
	): Promise<PositionStats> {
		const have = this.known(fenKey);
		if (have) return Promise.resolve(have);
		const pending = this.inflight.get(fenKey);
		if (pending) {
			// Someone now waits on it: let the explorer client move it up.
			if (priority === 'foreground') {
				void this.deps
					.fetch(this.query(fenKey), { priority, maxAgeMs: MAX_STALE_MS })
					.catch(() => undefined);
			}
			return pending;
		}
		this.probes++;
		const p = this.deps
			.fetch(this.query(fenKey), { priority, maxAgeMs: MAX_STALE_MS })
			.then((res) => {
				const s = toStats(res);
				this.stats.set(fenKey, s);
				return s;
			})
			.finally(() => this.inflight.delete(fenKey));
		this.inflight.set(fenKey, p);
		return p;
	}
}

function toStats(res: ExplorerResponse): PositionStats {
	const moves = res.moves.map((m) => ({
		uci: m.uci,
		san: m.san,
		games: m.white + m.draws + m.black
	}));
	return { total: moves.reduce((s, m) => s + m.games, 0), moves };
}

/**
 * Games for one move from a position's stats. A move the explorer didn't
 * list is rarer than every listed one when the list was cut off, and unseen
 * otherwise.
 */
function gamesOf(stats: PositionStats, uci: string): number {
	const m = stats.moves.find((x) => x.uci === uci);
	if (m) return m.games;
	if (stats.moves.length < PROBE_MOVES) return 0;
	return Math.min(...stats.moves.map((x) => x.games));
}

/**
 * Games reaching an opponent position, from the frequencies stored on its
 * prepared moves (Lichess counts only). Undefined when none are stored.
 */
function storedTotal(node: RepertoireNode): number | undefined {
	for (const e of node.children) {
		if (e.frequency?.source === 'lichess') return e.frequency.total;
	}
	return undefined;
}

function applyUci(fen: string, uci: string): string | null {
	try {
		const chess = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
		const move = parseUci(uci);
		if (!move) return null;
		chess.play(move);
		return makeFen(chess.toSetup(), { epd: true });
	} catch {
		return null;
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException('Gap search aborted', 'AbortError');
}

class MaxHeap<T> {
	private items: T[] = [];
	constructor(private readonly score: (t: T) => number) {}
	get size(): number {
		return this.items.length;
	}
	push(item: T): void {
		const a = this.items;
		a.push(item);
		let i = a.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (this.score(a[parent]) >= this.score(a[i])) break;
			[a[parent], a[i]] = [a[i], a[parent]];
			i = parent;
		}
	}
	pop(): T | undefined {
		const a = this.items;
		if (a.length === 0) return undefined;
		const top = a[0];
		const last = a.pop()!;
		if (a.length > 0) {
			a[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < a.length && this.score(a[l]) > this.score(a[m])) m = l;
				if (r < a.length && this.score(a[r]) > this.score(a[m])) m = r;
				if (m === i) break;
				[a[i], a[m]] = [a[m], a[i]];
				i = m;
			}
		}
		return top;
	}
}

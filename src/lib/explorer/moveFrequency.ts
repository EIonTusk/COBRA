/**
 * Move frequencies for the drill's "most common lines first" ordering
 * (issue #86 follow-up). Opponent moves carry how often they're played from
 * their position (`Edge.frequency`); the drill multiplies them along a line
 * to rank new moves by how likely you are to reach them.
 *
 * Frequencies are captured wherever the explorer data is already in hand —
 * the builder when a line is saved, the masters auto-builder — and by a
 * one-off background backfill for repertoires that arrive without it (PGN /
 * study / chess.com / broadcast imports, repertoires built before this).
 */
import { colorToMove } from '$lib/chess/fen';
import { getDB } from '$lib/storage/db';
import { markRepDirty } from '$lib/sync/dirtyMark';
import type { MoveFrequency, Repertoire, RepertoireNode } from '$lib/types';
import {
	ExplorerAuthRequired,
	ExplorerRateLimited,
	fetchExplorer,
	type ExplorerResponse
} from './client';

/**
 * Stored frequencies older than this are refreshed when fresh data is in
 * hand. Opening statistics drift slowly; this only bounds how stale a
 * number can get on a repertoire that's still being worked on.
 */
export const FREQUENCY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Lichess (rated games in the user's bands) beats masters/player counts. */
const SOURCE_RANK: Record<MoveFrequency['source'], number> = {
	lichess: 2,
	player: 1,
	masters: 1
};

/**
 * Counts for one move from an explorer response. A move missing from the
 * response (the explorer lists only the top moves) is recorded as 0 games —
 * it's rare in that database. Null when the position has no games at all.
 * Matched by SAN, which is unambiguous per position and sidesteps UCI
 * castling-notation differences.
 */
export function frequencyFromExplorer(
	res: ExplorerResponse,
	san: string,
	source: MoveFrequency['source'],
	now: number
): MoveFrequency | null {
	const total = res.white + res.draws + res.black;
	if (!(total > 0)) return null;
	const m = res.moves.find((x) => x.san === san);
	const games = m ? m.white + m.draws + m.black : 0;
	return { games, total, source, fetchedAt: now };
}

function shouldReplace(existing: MoveFrequency | undefined, next: MoveFrequency): boolean {
	if (!existing) return true;
	if (SOURCE_RANK[next.source] !== SOURCE_RANK[existing.source]) {
		return SOURCE_RANK[next.source] > SOURCE_RANK[existing.source];
	}
	return next.fetchedAt - existing.fetchedAt >= FREQUENCY_MAX_AGE_MS;
}

/**
 * Record frequencies for the opponent moves prepared at `fenKey` from an
 * explorer response for that position. No-op when it's the user's move
 * there (their own replies aren't a matter of chance). Doesn't stamp the
 * edge's `updatedAt` — frequency is derived data and must not win a sync
 * last-write-wins over a real edit (see mergeNode). Returns edges updated.
 */
export async function captureMoveFrequencies(
	rep: Pick<Repertoire, 'id' | 'color'>,
	fenKey: string,
	res: ExplorerResponse,
	source: MoveFrequency['source'],
	now: number = Date.now()
): Promise<number> {
	if (colorToMove(fenKey) === rep.color) return 0;
	const db = await getDB();
	const node = await db.get('nodes', [rep.id, fenKey]);
	if (!node) return 0;
	let changed = 0;
	for (const edge of node.children) {
		const next = frequencyFromExplorer(res, edge.san, source, now);
		if (!next || !shouldReplace(edge.frequency, next)) continue;
		edge.frequency = next;
		changed++;
	}
	if (changed > 0) {
		await db.put('nodes', node);
		markRepDirty(rep.id);
	}
	return changed;
}

/** Opponent-to-move positions reachable from the root, shallowest first. */
function opponentNodes(
	rep: Pick<Repertoire, 'rootFenKey' | 'color'>,
	nodes: Map<string, RepertoireNode>
): RepertoireNode[] {
	const out: RepertoireNode[] = [];
	const seen = new Set<string>([rep.rootFenKey]);
	const queue = [rep.rootFenKey];
	for (let i = 0; i < queue.length; i++) {
		const node = nodes.get(queue[i]);
		if (!node) continue;
		if (node.children.length > 0 && colorToMove(node.fenKey) !== rep.color) out.push(node);
		for (const e of node.children) {
			if (seen.has(e.toFenKey)) continue;
			seen.add(e.toFenKey);
			queue.push(e.toFenKey);
		}
	}
	return out;
}

/** How many prepared opponent moves have frequency data. */
export function frequencyCoverage(
	rep: Pick<Repertoire, 'rootFenKey' | 'color'>,
	nodes: Map<string, RepertoireNode>
): { withData: number; total: number } {
	let withData = 0;
	let total = 0;
	for (const node of opponentNodes(rep, nodes)) {
		for (const e of node.children) {
			total++;
			if (e.frequency) withData++;
		}
	}
	return { withData, total };
}

export interface BackfillOptions {
	token: string;
	speeds?: string[];
	ratings?: number[];
	signal?: AbortSignal;
	/**
	 * Extra pause between positions. The explorer client already spaces
	 * background requests out, so none is needed by default.
	 */
	delayMs?: number;
	onProgress?: (done: number, todo: number) => void;
}

export interface BackfillResult {
	/** Positions whose frequencies were filled in this run. */
	filled: number;
	/** Positions still missing data (0 = done). */
	remaining: number;
	stoppedBy?: 'rate-limit' | 'auth' | 'aborted' | 'error';
}

/**
 * Fill in missing (or non-Lichess) opponent-move frequencies, shallowest
 * positions first (they matter most for ordering). One explorer request per
 * position, run sequentially through the explorer client's single-flight
 * queue and persistent cache. Resumable: it only visits positions that still
 * need data, and stops cleanly on a rate limit, missing token or abort — the
 * next run picks up where this one left off.
 */
export async function backfillMoveFrequencies(
	rep: Pick<Repertoire, 'id' | 'color' | 'rootFen' | 'rootFenKey'>,
	nodes: Map<string, RepertoireNode>,
	opts: BackfillOptions
): Promise<BackfillResult> {
	// Masters / player counts (from the auto-builder) are upgraded to Lichess
	// counts in the user's own rating bands.
	const todo = opponentNodes(rep, nodes).filter((n) =>
		n.children.some((e) => e.frequency?.source !== 'lichess')
	);
	let filled = 0;
	const delay = opts.delayMs ?? 0;
	for (let i = 0; i < todo.length; i++) {
		if (opts.signal?.aborted) {
			return { filled, remaining: todo.length - i, stoppedBy: 'aborted' };
		}
		const node = todo[i];
		const fen = node.fenKey === rep.rootFenKey ? rep.rootFen : `${node.fenKey} 0 1`;
		try {
			// Background: yields to whatever the user is looking at, and the
			// client spaces background requests out (see client.ts).
			const res = await fetchExplorer(
				{
					fen,
					speeds: opts.speeds,
					ratings: opts.ratings,
					moves: 10,
					token: opts.token
				},
				{ priority: 'background', signal: opts.signal }
			);
			await captureMoveFrequencies(rep, node.fenKey, res, 'lichess');
			filled++;
		} catch (e) {
			const stoppedBy = opts.signal?.aborted
				? 'aborted'
				: e instanceof ExplorerRateLimited
					? 'rate-limit'
					: e instanceof ExplorerAuthRequired
						? 'auth'
						: 'error';
			return { filled, remaining: todo.length - i, stoppedBy };
		}
		opts.onProgress?.(i + 1, todo.length);
		if (delay > 0 && i + 1 < todo.length) await new Promise((r) => setTimeout(r, delay));
	}
	return { filled, remaining: 0 };
}

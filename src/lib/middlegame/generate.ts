/**
 * Build a middle-game guide for a position by combining Lichess masters
 * data with our local aggregation. Flow:
 *
 *   1. Hit /masters at the leaf FEN with `topGames=N` to get game metadata.
 *   2. Fetch each masters PGN (cached forever — master games don't change).
 *   3. Walk each PGN's mainline, locate the position matching our base
 *      fenKey, and collect the next ~12 plies of UCI.
 *   4. Pass the collected lines to `aggregateLines` + `formatGuide`.
 *
 * Errors on individual games are swallowed — the surrounding aggregate is
 * the deliverable, and one stale slug shouldn't sink it. Surface-level
 * failures (no token, rate-limited explorer) bubble up.
 */
import type { Position } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { parsePgn, startingPosition, type ChildNode, type PgnNodeData } from 'chessops/pgn';
import { parseSan } from 'chessops/san';
import { makeUci } from 'chessops/util';

import { fetchExplorer, type ExplorerResponse } from '$lib/explorer/client';
import { fetchMastersGamePgn } from '$lib/lichess/singleGame';

import { aggregateLines, type MiddlegameAggregate } from './aggregate';
import { formatGuide } from './format';

export interface GenerateOptions {
	fen: string;
	fenKey: string;
	token: string;
	/** How many master games to draw from. Default 10. */
	topGames?: number;
	/** Plies forward from the leaf to aggregate. Default 12. */
	maxPlies?: number;
	/**
	 * Reports incremental progress so the UI can show "fetched 3 / 10 games".
	 * Called with `{ phase: 'explorer' | 'pgn' | 'aggregate' | 'done', current?, total? }`.
	 */
	onProgress?: (p: GenerateProgress) => void;
}

export type GenerateProgress =
	| { phase: 'explorer' }
	| { phase: 'pgn'; current: number; total: number }
	| { phase: 'aggregate' }
	| { phase: 'done' };

export interface GenerateResult {
	guide: string;
	aggregate: MiddlegameAggregate;
	openingName: string | null;
	gamesQueried: number;
	gamesUsable: number;
}

const pgnCache = new Map<string, string>();

export async function generateMiddlegameGuide(options: GenerateOptions): Promise<GenerateResult> {
	const topGames = options.topGames ?? 10;
	const maxPlies = options.maxPlies ?? 12;
	const progress = options.onProgress ?? (() => {});

	progress({ phase: 'explorer' });
	const explorer: ExplorerResponse = await fetchExplorer({
		fen: options.fen,
		source: 'masters',
		topGames,
		token: options.token
	});

	const games = explorer.topGames ?? [];
	if (games.length === 0) {
		const empty = aggregateLines(options.fen, []);
		const guide = formatGuide(empty, { openingName: explorer.opening?.name ?? null });
		progress({ phase: 'done' });
		return {
			guide,
			aggregate: empty,
			openingName: explorer.opening?.name ?? null,
			gamesQueried: 0,
			gamesUsable: 0
		};
	}

	const lines: string[][] = [];
	let fetched = 0;
	for (const g of games) {
		fetched++;
		progress({ phase: 'pgn', current: fetched, total: games.length });
		try {
			const pgn = await fetchMastersPgnCached(g.id, options.token);
			const sub = continuationFromPgn(pgn, options.fenKey, maxPlies);
			if (sub && sub.length > 0) lines.push(sub);
		} catch {
			/* swallow — one bad game shouldn't kill the batch */
		}
	}

	progress({ phase: 'aggregate' });
	const aggregate = aggregateLines(options.fen, lines, { maxPlies });
	const guide = formatGuide(aggregate, { openingName: explorer.opening?.name ?? null });
	progress({ phase: 'done' });

	return {
		guide,
		aggregate,
		openingName: explorer.opening?.name ?? null,
		gamesQueried: games.length,
		gamesUsable: lines.length
	};
}

async function fetchMastersPgnCached(id: string, token: string): Promise<string> {
	const cached = pgnCache.get(id);
	if (cached !== undefined) return cached;
	const pgn = await fetchMastersGamePgn(id, token);
	pgnCache.set(id, pgn);
	return pgn;
}

/**
 * Parse a PGN, walk its mainline, and return the next `maxPlies` UCI moves
 * after the position whose EPD equals `targetFenKey`. Returns null if the
 * position never appears (game took a different path or PGN is malformed).
 */
export function continuationFromPgn(
	pgn: string,
	targetFenKey: string,
	maxPlies: number
): string[] | null {
	const games = parsePgn(pgn);
	for (const game of games) {
		const posResult = startingPosition(game.headers);
		if (posResult.isErr) continue;
		const pos = posResult.value;
		const collected = walkMainline(game.moves, pos, targetFenKey, maxPlies);
		if (collected) return collected;
	}
	return null;
}

function walkMainline(
	root: { children: ChildNode<PgnNodeData>[] },
	pos: Position,
	targetFenKey: string,
	maxPlies: number
): string[] | null {
	let cursor: { children: ChildNode<PgnNodeData>[] } = root;
	const working = pos.clone();
	let matched = makeFen(working.toSetup(), { epd: true }) === targetFenKey;
	const after: string[] = [];

	while (cursor.children.length > 0) {
		if (matched && after.length >= maxPlies) break;
		// Mainline = first child at every node.
		const next = cursor.children[0];
		const move = parseSan(working, next.data.san);
		if (!move) break;
		const uci = makeUci(move);
		working.play(move);
		if (matched) {
			after.push(uci);
		} else if (makeFen(working.toSetup(), { epd: true }) === targetFenKey) {
			matched = true;
		}
		cursor = next;
	}

	return matched ? after : null;
}

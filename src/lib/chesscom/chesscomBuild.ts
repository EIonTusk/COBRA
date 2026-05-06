/**
 * Seed a repertoire from a chess.com user's own games. Chess.com has no
 * explorer-like aggregate API, so we stream the user's recent games, parse
 * each PGN mainline into a position → move frequency map, then walk that map
 * from `startFen` with the same pick logic as the masters / player builds:
 * narrow at our-side positions, fan out at opponent-side positions.
 */

import { parsePgn, startingPosition } from 'chessops/pgn';
import { parseSan, makeSanAndPlay } from 'chessops/san';
import { makeFen, parseFen } from 'chessops/fen';
import { makeUci } from 'chessops/util';

import { streamChesscomGames } from './games';
import { colorToMove } from '$lib/chess/fen';
import { fenAfterMove } from '$lib/chess/position';
import { addEdge } from '$lib/storage/nodes';
import { getCard, upsertCard } from '$lib/storage/cards';
import { createFreshCard } from '$lib/fsrs/scheduler';
import type { Color, Edge } from '$lib/types';

export interface ChesscomBuildOpts {
	repId: string;
	color: Color;
	startFen: string;
	depth: number;
	username: string;
	/** Hard cap on chess.com games streamed for aggregation. */
	maxGames?: number;
	/** Skip games played before this timestamp (ms since epoch). */
	since?: number;
	/** Fan-out at opponent-to-move positions. 1 = mainline only. */
	opponentFanout?: number;
	signal?: AbortSignal;
	onProgress?: (p: ChesscomBuildProgress) => void;
}

export interface ChesscomBuildProgress {
	phase: 'fetching' | 'walking';
	gamesScanned: number;
	gamesMatched: number;
	probed: number;
	edgesAdded: number;
	cardsAdded: number;
}

export interface ChesscomBuildResult {
	gamesScanned: number;
	gamesMatched: number;
	probed: number;
	edgesAdded: number;
	cardsAdded: number;
}

interface MoveStats {
	san: string;
	uci: string;
	toFenKey: string;
	count: number;
}

export async function buildFromChesscom(opts: ChesscomBuildOpts): Promise<ChesscomBuildResult> {
	const maxGames = opts.maxGames ?? 50;
	const opponentFanout = opts.opponentFanout ?? 2;
	const lowerUser = opts.username.trim().toLowerCase();
	if (!lowerUser) throw new Error('chess.com username is required.');

	const progress: ChesscomBuildProgress = {
		phase: 'fetching',
		gamesScanned: 0,
		gamesMatched: 0,
		probed: 0,
		edgesAdded: 0,
		cardsAdded: 0
	};
	opts.onProgress?.({ ...progress });

	// Phase 1 — stream the user's games and build a position → move-frequency
	// map for games where the user played the requested colour.
	const stats = new Map<string, Map<string, MoveStats>>();
	for await (const game of streamChesscomGames(opts.username, {
		max: maxGames,
		since: opts.since,
		signal: opts.signal
	})) {
		if (opts.signal?.aborted) break;
		progress.gamesScanned += 1;
		if (game.variant !== 'standard' || !game.pgn) {
			opts.onProgress?.({ ...progress });
			continue;
		}
		const whiteName = (game.players.white.user?.name ?? '').toLowerCase();
		const blackName = (game.players.black.user?.name ?? '').toLowerCase();
		const userIsWhite = whiteName === lowerUser;
		const userIsBlack = blackName === lowerUser;
		if (!userIsWhite && !userIsBlack) {
			opts.onProgress?.({ ...progress });
			continue;
		}
		if (opts.color === 'white' && !userIsWhite) {
			opts.onProgress?.({ ...progress });
			continue;
		}
		if (opts.color === 'black' && !userIsBlack) {
			opts.onProgress?.({ ...progress });
			continue;
		}

		const parsed = parsePgn(game.pgn);
		if (parsed.length === 0) {
			opts.onProgress?.({ ...progress });
			continue;
		}
		const startR = startingPosition(parsed[0].headers);
		if (startR.isErr) {
			opts.onProgress?.({ ...progress });
			continue;
		}
		const pos = startR.value;
		progress.gamesMatched += 1;

		for (const node of parsed[0].moves.mainline()) {
			const move = parseSan(pos, node.san);
			if (!move) break;
			const fromFenKey = makeFen(pos.toSetup(), { epd: true });
			const san = makeSanAndPlay(pos, move);
			const uci = makeUci(move);
			const toFenKey = makeFen(pos.toSetup(), { epd: true });

			let inner = stats.get(fromFenKey);
			if (!inner) {
				inner = new Map();
				stats.set(fromFenKey, inner);
			}
			const existing = inner.get(uci);
			if (existing) existing.count += 1;
			else inner.set(uci, { san, uci, toFenKey, count: 1 });
		}
		opts.onProgress?.({ ...progress });
	}

	// Phase 2 — BFS from startFen over the aggregated stats, mirroring the
	// masters walker's narrow-on-ours / fan-out-on-theirs pick logic.
	progress.phase = 'walking';
	opts.onProgress?.({ ...progress });

	const visited = new Set<string>();
	const queue: Array<{ fen: string; ply: number }> = [{ fen: opts.startFen, ply: 0 }];

	while (queue.length > 0) {
		if (opts.signal?.aborted) break;
		const { fen, ply } = queue.shift()!;
		if (ply >= opts.depth) continue;
		const fenKey = makeFen(parseFen(fen).unwrap(), { epd: true });
		if (visited.has(fenKey)) continue;
		visited.add(fenKey);
		progress.probed += 1;
		opts.onProgress?.({ ...progress });

		const moves = stats.get(fenKey);
		if (!moves || moves.size === 0) continue;

		const sorted = [...moves.values()].sort((a, b) => b.count - a.count);
		const stm = colorToMove(fenKey);
		const isOurTurn = stm === opts.color;
		const take = isOurTurn ? 1 : opponentFanout;
		const picks = sorted.slice(0, take);

		for (const m of picks) {
			const edge: Edge = { san: m.san, uci: m.uci, toFenKey: m.toFenKey };
			const result = await addEdge(opts.repId, fenKey, edge);
			if (result.created) progress.edgesAdded += 1;
			if (isOurTurn) {
				const existing = await getCard(opts.repId, fenKey);
				if (!existing) {
					await upsertCard(createFreshCard(opts.repId, fenKey, edge.san));
					progress.cardsAdded += 1;
				}
			}
			const nextFen = fenAfterMove(fen, edge);
			queue.push({ fen: nextFen, ply: ply + 1 });
			opts.onProgress?.({ ...progress });
		}
	}

	return {
		gamesScanned: progress.gamesScanned,
		gamesMatched: progress.gamesMatched,
		probed: progress.probed,
		edgesAdded: progress.edgesAdded,
		cardsAdded: progress.cardsAdded
	};
}

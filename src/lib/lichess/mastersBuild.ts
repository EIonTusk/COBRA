/**
 * Walk the Lichess masters explorer recursively to seed a repertoire with
 * the moves master-level players actually play. Narrow at user-side
 * positions (take only the top move) and fan out at opponent-side positions
 * (top N replies) so the resulting tree has canonical mainline + the common
 * responses a user needs prepared replies to.
 */

import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { parseSan, makeSanAndPlay } from 'chessops/san';
import { parseUci, makeUci } from 'chessops/util';

import { fetchExplorer } from '$lib/explorer/client';
import { colorToMove } from '$lib/chess/fen';
import { addEdge } from '$lib/storage/nodes';
import { getCard, upsertCard } from '$lib/storage/cards';
import { createFreshCard } from '$lib/fsrs/scheduler';
import type { Color, Edge } from '$lib/types';

export interface MastersBuildOpts {
	repId: string;
	color: Color;
	startFen: string; // full FEN — the position to begin the walk from
	depth: number; // max ply depth from startFen
	token?: string;
	signal?: AbortSignal;
	maxProbes?: number;
	/** Fan-out at opponent-to-move positions. 1 = mainline only, 3 = canonical + 2 sidelines. */
	opponentFanout?: number;
	/** Skip moves below this absolute game count to avoid curious one-offs. */
	minGames?: number;
	/**
	 * When set, walk a specific Lichess user's games via /player instead of
	 * the aggregate /masters DB. Takes a Lichess handle (e.g. "DrNykterstein").
	 * Lichess's /masters endpoint has no player filter, so players without a
	 * Lichess handle (Ding Liren, Caruana, …) can't be narrowed to.
	 */
	imitatePlayer?: string;
	onProgress?: (probed: number, edgesAdded: number) => void;
}

export interface MastersBuildResult {
	probed: number;
	edgesAdded: number;
	cardsAdded: number;
}

export async function buildFromMasters(opts: MastersBuildOpts): Promise<MastersBuildResult> {
	const maxProbes = opts.maxProbes ?? 80;
	const opponentFanout = opts.opponentFanout ?? 2;
	const minGames = opts.minGames ?? 50;

	const visited = new Set<string>();
	const queue: Array<{ fen: string; ply: number }> = [{ fen: opts.startFen, ply: 0 }];
	let probed = 0;
	let edgesAdded = 0;
	let cardsAdded = 0;

	while (queue.length > 0) {
		if (probed >= maxProbes) break;
		if (opts.signal?.aborted) break;
		const { fen, ply } = queue.shift()!;
		if (ply >= opts.depth) continue;
		const fenKey = makeFen(parseFen(fen).unwrap(), { epd: true });
		if (visited.has(fenKey)) continue;
		visited.add(fenKey);

		const res = opts.imitatePlayer
			? await fetchExplorer({
					fen,
					source: 'player',
					player: opts.imitatePlayer,
					playerColor: opts.color,
					moves: 6,
					token: opts.token
				})
			: await fetchExplorer({
					fen,
					source: 'masters',
					moves: 6,
					token: opts.token
				});
		probed += 1;
		opts.onProgress?.(probed, edgesAdded);

		if (!res.moves || res.moves.length === 0) continue;

		const stm = colorToMove(fenKey);
		const isOurTurn = stm === opts.color;
		const take = isOurTurn ? 1 : opponentFanout;
		const picks = res.moves.filter((m) => m.white + m.draws + m.black >= minGames).slice(0, take);

		for (const m of picks) {
			const edge = makeEdge(fen, m.uci, m.san);
			if (!edge) continue;
			const result = await addEdge(opts.repId, fenKey, edge);
			if (result.created) edgesAdded += 1;
			if (isOurTurn) {
				const existing = await getCard(opts.repId, fenKey);
				if (!existing) {
					await upsertCard(createFreshCard(opts.repId, fenKey, edge.san));
					cardsAdded += 1;
				}
			}
			const next = fenAfterMove(fen, edge);
			queue.push({ fen: next, ply: ply + 1 });
			opts.onProgress?.(probed, edgesAdded);
		}
	}

	return { probed, edgesAdded, cardsAdded };
}

function makeEdge(fromFen: string, uci: string, san: string): Edge | null {
	try {
		const setup = parseFen(fromFen).unwrap();
		const chess = Chess.fromSetup(setup).unwrap();
		const move = parseUci(uci);
		if (!move) return null;
		chess.play(move);
		const toFenKey = makeFen(chess.toSetup(), { epd: true });
		return { san, uci: makeUci(move), toFenKey };
	} catch {
		return null;
	}
}

function fenAfterMove(fromFen: string, edge: Edge): string {
	const setup = parseFen(fromFen).unwrap();
	const chess = Chess.fromSetup(setup).unwrap();
	const move = parseSan(chess, edge.san);
	if (!move) throw new Error(`Illegal SAN in edge: ${edge.san}`);
	makeSanAndPlay(chess, move);
	return makeFen(chess.toSetup());
}

/**
 * Play a prefix of SAN moves from the standard start to obtain a starting
 * FEN for the masters walk. Returns null if the prefix is invalid.
 */
export function startFenAfterPrefix(prefixSans: string[]): string | null {
	const setup = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1').unwrap();
	const chess = Chess.fromSetup(setup).unwrap();
	for (const san of prefixSans) {
		const move = parseSan(chess, san);
		if (!move) return null;
		makeSanAndPlay(chess, move);
	}
	return makeFen(chess.toSetup());
}

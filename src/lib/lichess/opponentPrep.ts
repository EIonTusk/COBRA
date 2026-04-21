/**
 * Opponent prep analyzer. Given a Lichess username, the colour *we* will
 * play against them, and one of our repertoires, walks their recent games
 * ply-by-ply to count how often each opponent move shows up in positions
 * already covered by our tree — and flags the ones our repertoire hasn't
 * answered yet.
 *
 * Walks stop the moment the played position drops out of our tree (either
 * because the player-on-our-side deviated from our prep, or because the
 * opponent picked a move we haven't recorded a reply for yet): past that
 * point the remaining moves are played from positions we'd never reach.
 */
import { parsePgn, startingPosition } from 'chessops/pgn';
import { parseSan, makeSanAndPlay } from 'chessops/san';
import { makeFen } from 'chessops/fen';
import { makeUci } from 'chessops/util';

import { colorToMove } from '$lib/chess/fen';
import type { Color, RepertoireNode } from '$lib/types';
import { streamUserGames, type StreamOpts } from './games';

export interface OpponentMoveStat {
	fromFenKey: string;
	san: string;
	uci: string;
	count: number;
	covered: boolean;
}

export interface OpponentPrepResult {
	gamesScanned: number;
	gamesUsed: number;
	plyCovered: number;
	uncovered: OpponentMoveStat[];
	covered: OpponentMoveStat[];
}

export interface RunOpts extends Omit<StreamOpts, 'max'> {
	username: string;
	/** Colour we will play — we count moves from the *other* side. */
	ourColor: Color;
	maxGames?: number;
	rep: {
		rootFenKey: string;
		color: Color;
		nodes: Map<string, RepertoireNode>;
	};
	onProgress?: (seen: number, used: number) => void;
}

export async function analyzeOpponent(opts: RunOpts): Promise<OpponentPrepResult> {
	const { username, ourColor, rep } = opts;
	const opponentColor: Color = ourColor === 'white' ? 'black' : 'white';
	const lowerUser = username.toLowerCase();

	const counts = new Map<string, { san: string; uci: string; count: number; fromFenKey: string }>();
	let gamesScanned = 0;
	let gamesUsed = 0;
	let plyCovered = 0;

	for await (const game of streamUserGames(username, {
		token: opts.token,
		max: opts.maxGames ?? 50,
		rated: opts.rated,
		variant: opts.variant ?? 'standard',
		since: opts.since,
		signal: opts.signal
	})) {
		gamesScanned += 1;
		opts.onProgress?.(gamesScanned, gamesUsed);

		if (!game.pgn) continue;
		const oppIsWhite = (game.players.white.user?.name ?? '').toLowerCase() === lowerUser;
		const oppIsBlack = (game.players.black.user?.name ?? '').toLowerCase() === lowerUser;
		if (!oppIsWhite && !oppIsBlack) continue;
		const actualOpponentColor: Color = oppIsWhite ? 'white' : 'black';
		if (actualOpponentColor !== opponentColor) continue;

		const parsed = parsePgn(game.pgn);
		if (parsed.length === 0) continue;
		const pgn = parsed[0];
		const startR = startingPosition(pgn.headers);
		if (startR.isErr) continue;
		const pos = startR.value.clone();

		let fenKey = makeFen(pos.toSetup(), { epd: true });
		if (fenKey !== rep.rootFenKey) continue;
		gamesUsed += 1;

		for (const node of pgn.moves.mainline()) {
			const treeNode = rep.nodes.get(fenKey);
			if (!treeNode) break;
			const sideToMove = colorToMove(fenKey);
			const move = parseSan(pos, node.san);
			if (!move) break;

			if (sideToMove === opponentColor) {
				const uci = makeUci(move);
				const key = `${fenKey}|${uci}`;
				const entry = counts.get(key);
				if (entry) entry.count += 1;
				else counts.set(key, { san: node.san, uci, count: 1, fromFenKey: fenKey });
				plyCovered += 1;
			} else {
				// Our side: only keep walking if the move stays inside our prep.
				const edge = treeNode.children.find((e) => e.san === node.san);
				if (!edge) break;
			}

			makeSanAndPlay(pos, move);
			fenKey = makeFen(pos.toSetup(), { epd: true });
		}
	}

	const uncovered: OpponentMoveStat[] = [];
	const covered: OpponentMoveStat[] = [];
	for (const e of counts.values()) {
		const node = rep.nodes.get(e.fromFenKey);
		const isCovered = !!node && node.children.some((edge) => edge.uci === e.uci);
		const stat: OpponentMoveStat = {
			fromFenKey: e.fromFenKey,
			san: e.san,
			uci: e.uci,
			count: e.count,
			covered: isCovered
		};
		if (isCovered) covered.push(stat);
		else uncovered.push(stat);
	}
	uncovered.sort((a, b) => b.count - a.count);
	covered.sort((a, b) => b.count - a.count);

	return { gamesScanned, gamesUsed, plyCovered, uncovered, covered };
}

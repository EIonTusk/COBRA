/**
 * Post-game reconciliation for Lichess bot challenges launched from Cobra.
 *
 * Every spar game sits in the `spar_games` store as `status: 'pending'`
 * from the moment it's fired. This module pulls the PGN for each
 * pending game, walks it against the owning repertoire's tree, and:
 *
 *   - leaves it pending if the game hasn't finished yet
 *   - marks it `analysed` once done, recording the outcome + (if any)
 *     first off-tree user move as a structured `result` field
 *   - funnels the first off-tree move into the existing mistake
 *     pipeline so it surfaces in the Mistake drill
 *
 * The PGN respects the starting FEN the challenge was created with — we
 * rely on `chessops/pgn` `startingPosition(headers)` to honour the
 * `[FEN]` + `[SetUp "1"]` header pair the way the existing
 * mistake-detection code does.
 */

import { parsePgn, startingPosition } from 'chessops/pgn';
import { parseSan } from 'chessops/san';
import { makeFen } from 'chessops/fen';

import { colorToMove } from '$lib/chess/fen';
import { fetchLichessGamePgnIfReady } from './singleGame';
import { nodesMap } from '$lib/storage/nodes';
import { getRepertoire } from '$lib/storage/repertoires';
import { saveMistakes, toStored } from '$lib/storage/mistakes';
import { upsertSparGame, listPendingSparGames } from '$lib/storage/sparGames';
import type { MistakeRecord } from './mistakes';
import type { Color, RepertoireNode, SparGame } from '$lib/types';

/**
 * Re-check a pending spar game. Returns the (possibly updated) record.
 * Safe to call repeatedly — short-circuits when the game's still
 * ongoing or when the last check was too recent.
 */
export async function reconcileSparGame(
	record: SparGame,
	opts: { token?: string; username?: string; minCheckIntervalMs?: number } = {}
): Promise<SparGame> {
	if (record.status === 'analysed') return record;
	const minInterval = opts.minCheckIntervalMs ?? 30_000;
	if (record.lastCheckedAt && Date.now() - record.lastCheckedAt < minInterval) {
		return record;
	}

	let pgn: string | null;
	try {
		pgn = await fetchLichessGamePgnIfReady(record.id, opts.token);
	} catch (e) {
		// Rate-limit / HTTP / network error from Lichess. Keep the record
		// pending — the next tick will retry. We stash the message so the
		// UI can show it, but don't flip to 'error' since most failures
		// here are transient.
		const next: SparGame = {
			...record,
			status: 'pending',
			lastCheckedAt: Date.now(),
			lastError: e instanceof Error ? e.message : String(e)
		};
		await upsertSparGame(next);
		return next;
	}

	if (pgn === null) {
		// Lichess responded 200 but with an empty body — the game hasn't
		// finished yet (or the bot hasn't accepted the challenge). Keep
		// the record pending; clear any prior error so the UI doesn't
		// show stale failure text while we just wait.
		const next: SparGame = {
			...record,
			status: 'pending',
			lastCheckedAt: Date.now(),
			lastError: undefined
		};
		await upsertSparGame(next);
		return next;
	}

	const parsed = parsePgn(pgn);
	if (parsed.length === 0) {
		const next: SparGame = {
			...record,
			status: 'pending',
			lastCheckedAt: Date.now(),
			lastError: 'Unparseable PGN.'
		};
		await upsertSparGame(next);
		return next;
	}
	const game = parsed[0];
	const result = (game.headers.get('Result') ?? '*').trim();
	if (result === '*') {
		// Still in progress — update timestamp and leave pending so the
		// next visit retries.
		const next: SparGame = {
			...record,
			status: 'pending',
			lastCheckedAt: Date.now(),
			lastError: undefined
		};
		await upsertSparGame(next);
		return next;
	}

	// Figure out which colour the user actually played: prefer a PGN
	// header match against the logged-in Lichess username, fall back to
	// the colour we stored at challenge time (honour 'random' by
	// keeping whichever we ended up with).
	const white = (game.headers.get('White') ?? '').toLowerCase();
	const black = (game.headers.get('Black') ?? '').toLowerCase();
	const me = (opts.username ?? '').toLowerCase();
	let userColor: Color = record.userColor;
	if (me && white === me) userColor = 'white';
	else if (me && black === me) userColor = 'black';

	const outcome: 'win' | 'loss' | 'draw' | 'unfinished' =
		result === '1/2-1/2'
			? 'draw'
			: result === '1-0'
				? userColor === 'white'
					? 'win'
					: 'loss'
				: result === '0-1'
					? userColor === 'black'
						? 'win'
						: 'loss'
					: 'unfinished';

	// Walk the moves against the repertoire tree.
	const rep = await getRepertoire(record.repertoireId);
	const nodes: Map<string, RepertoireNode> = rep ? await nodesMap(record.repertoireId) : new Map();

	const startR = startingPosition(game.headers);
	if (startR.isErr) {
		const next: SparGame = {
			...record,
			status: 'error',
			lastCheckedAt: Date.now(),
			lastError: 'Unparseable starting position.'
		};
		await upsertSparGame(next);
		return next;
	}
	const pos = startR.value;
	let fenKey = makeFen(pos.toSetup(), { epd: true });
	let fen = makeFen(pos.toSetup());
	let ply = 0;
	let deviation: {
		fenKey: string;
		fen: string;
		playedSan: string;
		expectedSan: string;
		plyOffTree: number;
	} | null = null;

	for (const node of game.moves.mainline()) {
		const move = parseSan(pos, node.san);
		if (!move) break;
		const userTurn = colorToMove(fenKey) === userColor;
		if (userTurn && rep) {
			const treeNode = nodes.get(fenKey);
			if (treeNode && treeNode.children.length > 0) {
				const edge = treeNode.children.find((e) => e.san === node.san);
				if (!edge) {
					deviation = {
						fenKey,
						fen,
						playedSan: node.san,
						expectedSan: treeNode.children[0].san,
						plyOffTree: ply
					};
					break;
				}
			}
			// treeNode missing or empty = prep ran out. We don't mark that
			// as a user *mistake* (the opponent drove us off-tree), so
			// nothing to record here; just stop looking for deviations.
			if (!treeNode || treeNode.children.length === 0) break;
		}
		pos.play(move);
		fenKey = makeFen(pos.toSetup(), { epd: true });
		fen = makeFen(pos.toSetup());
		ply += 1;
	}

	// If we found a deviation, push it through the mistake pipeline —
	// the dashboard and the Mistake drill both read from there.
	if (deviation && rep) {
		const mistake: MistakeRecord = {
			gameId: record.id,
			playedAt: record.startedAt,
			speed: 'correspondence',
			color: userColor,
			opponent: record.opponentLabel,
			gameUrl: record.gameUrl,
			repertoireId: rep.id,
			repertoireName: rep.name,
			fenKey: deviation.fenKey,
			fen: deviation.fen,
			playedSan: deviation.playedSan,
			expectedSan: deviation.expectedSan,
			plyOffTree: deviation.plyOffTree
		};
		try {
			await saveMistakes([toStored(mistake)]);
		} catch (e) {
			console.warn('[spar review] saveMistakes failed:', e);
		}
	}

	const finalPlies = ply; // total user+opponent plies walked
	const next: SparGame = {
		...record,
		userColor,
		status: 'analysed',
		lastCheckedAt: Date.now(),
		lastError: undefined,
		result: {
			outcome,
			plies: finalPlies,
			deviationPly: deviation?.plyOffTree,
			deviationFenKey: deviation?.fenKey,
			deviationPlayedSan: deviation?.playedSan,
			deviationExpectedSan: deviation?.expectedSan
		}
	};
	await upsertSparGame(next);
	return next;
}

/**
 * Reconcile every pending spar game in the store. Concurrency is kept
 * sequential to respect Lichess's sparse rate limit for the
 * game-export endpoint (no explicit limit published, but one-at-a-time
 * is safe). Returns the number of games whose status flipped from
 * 'pending' to 'analysed' during this pass.
 */
export async function reconcileAllPending(opts: {
	token?: string;
	username?: string;
}): Promise<number> {
	const pending = await listPendingSparGames();
	let analysed = 0;
	for (const rec of pending) {
		try {
			const next = await reconcileSparGame(rec, opts);
			if (next.status === 'analysed') analysed += 1;
		} catch (e) {
			console.warn('[spar review] reconcile failed for', rec.id, e);
		}
	}
	return analysed;
}

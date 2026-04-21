/**
 * Build a repertoire from Lichess broadcast PGNs, filtered client-side to
 * games involving a named player. This is the practical workaround for the
 * fact that the /masters explorer has no player filter: broadcasts cover OTB
 * events and include everyone who played, whether or not they have a Lichess
 * account. Coverage goes back to whenever Lichess started broadcasting the
 * event (modern era only — no Fischer, no Kasparov prime-years).
 */

import { parsePgn, startingPosition } from 'chessops/pgn';
import { parseSan, makeSanAndPlay } from 'chessops/san';
import { makeFen } from 'chessops/fen';
import { makeUci } from 'chessops/util';

import { colorToMove } from '$lib/chess/fen';
import { addEdge } from '$lib/storage/nodes';
import { getCard, upsertCard } from '$lib/storage/cards';
import { createFreshCard } from '$lib/fsrs/scheduler';
import { fetchBroadcastPgn, searchBroadcastsByPlayer } from './broadcasts';
import type { Color, Edge } from '$lib/types';

export interface BroadcastBuildOpts {
	repId: string;
	color: Color;
	depth: number;
	/** FIDE player to filter games by (selected from the search picker). */
	player: {
		id: number;
		/** Full name as shown on the FIDE page, e.g. "Ding, Liren". */
		name: string;
	};
	/** Cap on tournaments scanned (search already ranks by relevance). */
	maxTournaments?: number;
	token?: string;
	signal?: AbortSignal;
	onProgress?: (p: BroadcastBuildProgress) => void;
}

export interface BroadcastBuildProgress {
	tournamentsScanned: number;
	tournamentsTotal: number;
	gamesScanned: number;
	gamesMatched: number;
	edgesAdded: number;
	cardsAdded: number;
	currentTournament?: string;
}

/**
 * Build from Lichess broadcasts featuring the selected FIDE player. Flow:
 *
 *   1. Hit `/api/broadcast/search?q=<name>` (CORS-enabled, unlike the
 *      /fide/<id>/<slug> HTML page) to get only broadcasts that actually
 *      involve this player — the "First Last" form is the one Lichess's
 *      server-side index matches against.
 *   2. Keep the top `maxTournaments` (the API already ranks them by
 *      relevance / date).
 *   3. For each tournament, download its full PGN, skip fast if none of the
 *      name-variant needles appear in the text (cheap substring guard
 *      against false matches like team-event metadata), and otherwise
 *      parse and fold games where the player had the requested colour.
 *
 * Name needles cover "Last, First", "Last First", and "First Last", so
 * PGN-style headers ("Carlsen, M" / "Carlsen Magnus") match reliably
 * without collapsing to bare surnames that hit every namesake.
 */
export async function buildFromBroadcasts(
	opts: BroadcastBuildOpts
): Promise<BroadcastBuildProgress> {
	const fideName = opts.player.name.trim();
	if (!fideName) {
		throw new Error('Player is required for broadcast autobuild.');
	}
	const needles = nameNeedles(fideName);
	const maxTournaments = opts.maxTournaments ?? 15;

	// The search index matches against "First Last" strings better than the
	// comma-separated FIDE form.
	const queryName = toFirstLast(fideName);
	const tournaments = await searchBroadcastsByPlayer({
		query: queryName,
		maxPages: 3,
		token: opts.token,
		signal: opts.signal
	});
	// The PGN endpoint is keyed on `tour.id` (8-char opaque). Slugs 404.
	const picks = tournaments.slice(0, maxTournaments).map((t) => ({
		tourId: t.tour.id,
		name: t.tour.name
	}));

	const progress: BroadcastBuildProgress = {
		tournamentsScanned: 0,
		tournamentsTotal: picks.length,
		gamesScanned: 0,
		gamesMatched: 0,
		edgesAdded: 0,
		cardsAdded: 0
	};

	for (const t of picks) {
		if (opts.signal?.aborted) break;
		progress.currentTournament = t.name;
		opts.onProgress?.({ ...progress });

		let pgnText: string;
		try {
			pgnText = await fetchBroadcastPgn(t.tourId, {
				token: opts.token,
				signal: opts.signal
			});
		} catch (e) {
			if ((e as Error).name === 'AbortError') break;
			progress.tournamentsScanned += 1;
			opts.onProgress?.({ ...progress });
			continue;
		}

		// Quick string sniff: if none of the name variants appear in the raw
		// PGN text, skip parsing entirely. Very common: the tournaments list
		// on the FIDE page can include events where the player was a
		// commentator / guest rather than a competitor.
		const lower = pgnText.toLowerCase();
		if (!needles.some((n) => lower.includes(n))) {
			progress.tournamentsScanned += 1;
			opts.onProgress?.({ ...progress });
			continue;
		}

		const games = parsePgn(pgnText);
		for (const game of games) {
			if (opts.signal?.aborted) break;
			progress.gamesScanned += 1;
			const whiteName = (game.headers.get('White') ?? '').toLowerCase();
			const blackName = (game.headers.get('Black') ?? '').toLowerCase();
			const targetIsWhite = needles.some((n) => whiteName.includes(n));
			const targetIsBlack = needles.some((n) => blackName.includes(n));
			if (!targetIsWhite && !targetIsBlack) continue;
			// Only fold games where the target played the colour we're building
			// for — otherwise we'd be recording the opponent's choices as if
			// they were the target's.
			if (opts.color === 'white' && !targetIsWhite) continue;
			if (opts.color === 'black' && !targetIsBlack) continue;
			progress.gamesMatched += 1;

			await foldGame(opts.repId, opts.color, opts.depth, game, progress);
			opts.onProgress?.({ ...progress });
		}
		progress.tournamentsScanned += 1;
		opts.onProgress?.({ ...progress });
	}

	progress.currentTournament = undefined;
	return progress;
}

async function foldGame(
	repId: string,
	color: Color,
	depth: number,
	game: ReturnType<typeof parsePgn>[number],
	progress: BroadcastBuildProgress
): Promise<void> {
	const startR = startingPosition(game.headers);
	if (startR.isErr) return;
	const pos = startR.value;
	let fenKey = makeFen(pos.toSetup(), { epd: true });

	let ply = 0;
	for (const node of game.moves.mainline()) {
		if (ply >= depth) break;
		const move = parseSan(pos, node.san);
		if (!move) break;
		const forked = pos.clone();
		const san = makeSanAndPlay(forked, move);
		const uci = makeUci(move);
		const toFenKey = makeFen(forked.toSetup(), { epd: true });
		const edge: Edge = { san, uci, toFenKey };

		const res = await addEdge(repId, fenKey, edge);
		if (res.created) progress.edgesAdded += 1;
		if (colorToMove(fenKey) === color) {
			const existing = await getCard(repId, fenKey);
			if (!existing) {
				await upsertCard(createFreshCard(repId, fenKey, edge.san));
				progress.cardsAdded += 1;
			}
		}
		makeSanAndPlay(pos, move);
		fenKey = makeFen(pos.toSetup(), { epd: true });
		ply += 1;
	}
}

/**
 * Turn a FIDE-format name ("Ding, Liren") into lowercase substring variants
 * we can match against PGN White/Black headers. PGNs use "Last, First" and
 * "Last First" interchangeably; covering both keeps false negatives low
 * without widening the match to single-token collisions ("Ding" alone would
 * hit every Ding in a mixed event).
 */
/**
 * Convert "Ding, Liren" → "Ding Liren". The broadcast search index matches
 * "First Last" / "Last First" strings against player tag headers, and the
 * comma form routinely yields fewer hits.
 */
function toFirstLast(fideName: string): string {
	const commaIdx = fideName.indexOf(',');
	if (commaIdx < 0) return fideName.trim();
	const last = fideName.slice(0, commaIdx).trim();
	const first = fideName.slice(commaIdx + 1).trim();
	return `${last} ${first}`.trim();
}

function nameNeedles(fideName: string): string[] {
	const cleaned = fideName.trim();
	if (!cleaned) return [];
	const lower = cleaned.toLowerCase();
	const out = new Set<string>([lower]);
	const commaIdx = cleaned.indexOf(',');
	if (commaIdx > 0) {
		const last = cleaned.slice(0, commaIdx).trim().toLowerCase();
		const first = cleaned
			.slice(commaIdx + 1)
			.trim()
			.toLowerCase();
		if (last && first) {
			out.add(`${last} ${first}`);
			out.add(`${first} ${last}`);
			out.add(`${last}, ${first}`);
		}
	}
	return [...out];
}

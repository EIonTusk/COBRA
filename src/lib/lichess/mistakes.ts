/**
 * Analyze played games against all matching-colour repertoires. Returns the
 * "best-fit" outcome — the repertoire the user followed longest before either
 * going off-book themselves (mistake) or having the opponent drive them into
 * an unprepared position (gap). Games where at least one rep was followed
 * cleanly to the end are reported as having neither outcome.
 */

import { parsePgn, startingPosition } from 'chessops/pgn';
import { parseSan, makeSanAndPlay } from 'chessops/san';
import { makeFen } from 'chessops/fen';

import { colorToMove } from '$lib/chess/fen';
import type { Color, RepertoireNode } from '$lib/types';
import type { LichessGameMeta } from './games';

export interface MistakeRecord {
	gameId: string;
	playedAt: number;
	speed: string;
	color: Color;
	opponent: string;
	gameUrl: string;
	repertoireId: string;
	repertoireName: string;
	fenKey: string;
	fen: string;
	playedSan: string;
	expectedSan: string;
	plyOffTree: number;
}

export interface CandidateRep {
	id: string;
	name: string;
	color: Color;
	rootFenKey: string;
	nodes: Map<string, RepertoireNode>;
}

export interface GapRecord {
	gameId: string;
	playedAt: number;
	repertoireId: string;
	fenKey: string;
	fen: string;
	/** Plies into the game at which prep ran out. Used as the best-fit score. */
	plyOffTree: number;
}

/**
 * One row per (repertoire, fenKey, SAN) the user actually played *within*
 * their prep — i.e. on-tree moves, before any divergence. Together with
 * the game's final result this powers the builder's "you underperform
 * here vs the DB" indicator.
 */
export interface WdlHit {
	repertoireId: string;
	fenKey: string;
	playedSan: string;
	color: Color;
	/** Final game outcome from White's POV; 'draws' when no winner. */
	result: 'white' | 'draws' | 'black';
	gameId: string;
	playedAt: number;
}

export interface AnalyzedGame {
	mistake?: MistakeRecord;
	gap?: GapRecord;
	/** On-tree user moves — emitted regardless of mistake/gap outcome. */
	wdlHits?: WdlHit[];
}

/**
 * Run a game against every matching-colour repertoire and pick the best-fit
 * outcome: whichever rep the user followed deepest before either going
 * off-book themselves (mistake) or having prep run out on them (gap). If any
 * rep was followed cleanly to the end of the game, returns `{}` — nothing to
 * record.
 */
export function analyzeGame(
	game: LichessGameMeta,
	username: string,
	reps: CandidateRep[]
): AnalyzedGame {
	const res = detectInternal(game, username, reps);
	if (!res) return {};
	return res;
}

function gameResult(game: LichessGameMeta): 'white' | 'draws' | 'black' {
	if (game.winner === 'white') return 'white';
	if (game.winner === 'black') return 'black';
	return 'draws';
}

export function detectMistake(
	game: LichessGameMeta,
	username: string,
	reps: CandidateRep[]
): MistakeRecord | null {
	const res = detectInternal(game, username, reps);
	return res?.mistake ?? null;
}

function detectInternal(
	game: LichessGameMeta,
	username: string,
	reps: CandidateRep[]
): AnalyzedGame | null {
	if (!game.pgn) return null;
	const lowerUser = username.toLowerCase();
	const userIsWhite = (game.players.white.user?.name ?? '').toLowerCase() === lowerUser;
	const userIsBlack = (game.players.black.user?.name ?? '').toLowerCase() === lowerUser;
	if (!userIsWhite && !userIsBlack) return null;
	const userColor: Color = userIsWhite ? 'white' : 'black';
	const opponent =
		(userIsWhite ? game.players.black.user?.name : game.players.white.user?.name) ?? 'Anon';

	const candidates = reps.filter((r) => r.color === userColor);
	if (candidates.length === 0) return null;

	const parsed = parsePgn(game.pgn);
	if (parsed.length === 0) return null;
	const pgn = parsed[0];
	const startR = startingPosition(pgn.headers);
	if (startR.isErr) return null;
	const startPos = startR.value;

	type PerRep =
		| { kind: 'followed'; rep: CandidateRep }
		| { kind: 'mistake'; rep: CandidateRep; record: MistakeRecord; ply: number }
		| { kind: 'gap'; rep: CandidateRep; record: GapRecord; ply: number };

	const results: PerRep[] = [];
	const wdlHits: WdlHit[] = [];
	const result = gameResult(game);

	for (const rep of candidates) {
		const pos = startPos.clone();
		let fenKey = makeFen(pos.toSetup(), { epd: true });
		let fen = makeFen(pos.toSetup());
		let ply = 0;
		// Most recent fenKey (with full FEN) we traversed that exists as a node
		// in this rep's tree. When opponent eventually drives us out of the
		// tree, this is the position the user should be brought back to in the
		// builder to patch the hole.
		let lastInTreeFenKey: string | null = rep.nodes.has(fenKey) ? fenKey : null;
		let lastInTreeFen: string | null = lastInTreeFenKey ? fen : null;
		let outcome: PerRep | null = null;
		let pgnError = false;

		for (const node of pgn.moves.mainline()) {
			const move = parseSan(pos, node.san);
			if (!move) {
				pgnError = true;
				break;
			}
			const userTurn = colorToMove(fenKey) === userColor;
			if (userTurn) {
				const treeNode = rep.nodes.get(fenKey);
				if (!treeNode || treeNode.children.length === 0) {
					// Prep ran out on us. Prefer the current user-side fenKey
					// (it's in the tree as a leaf) — only fall back to the
					// last in-tree position if opponent took us completely
					// off-tree (treeNode missing).
					const gapFenKey = treeNode ? fenKey : lastInTreeFenKey;
					const gapFen = treeNode ? fen : lastInTreeFen;
					if (gapFenKey && gapFen) {
						outcome = {
							kind: 'gap',
							rep,
							ply,
							record: {
								gameId: game.id,
								playedAt: game.createdAt,
								repertoireId: rep.id,
								fenKey: gapFenKey,
								fen: gapFen,
								plyOffTree: ply
							}
						};
					}
					break;
				}
				const edge = treeNode.children.find((e) => e.san === node.san);
				if (!edge) {
					outcome = {
						kind: 'mistake',
						rep,
						ply,
						record: {
							gameId: game.id,
							playedAt: game.createdAt,
							speed: game.speed,
							color: userColor,
							opponent,
							gameUrl: `https://lichess.org/${game.id}`,
							repertoireId: rep.id,
							repertoireName: rep.name,
							fenKey,
							fen: makeFen(pos.toSetup()),
							playedSan: node.san,
							expectedSan: treeNode.children[0].san,
							plyOffTree: ply
						}
					};
					break;
				}
				// On-tree user move — credit this (rep, fenKey, SAN) with the
				// game's final result. Emitted for every in-prep move, not
				// just the final one, so the Candidates indicator can read
				// user performance at any position in the tree.
				wdlHits.push({
					repertoireId: rep.id,
					fenKey,
					playedSan: node.san,
					color: userColor,
					result,
					gameId: game.id,
					playedAt: game.createdAt
				});
			}
			makeSanAndPlay(pos, move);
			fenKey = makeFen(pos.toSetup(), { epd: true });
			fen = makeFen(pos.toSetup());
			if (rep.nodes.has(fenKey)) {
				lastInTreeFenKey = fenKey;
				lastInTreeFen = fen;
			}
			ply += 1;
		}

		if (pgnError) continue;
		if (!outcome) {
			// Fell out of the mainline loop without a mistake or gap — the user
			// followed this rep cleanly for the full game.
			results.push({ kind: 'followed', rep });
		} else {
			results.push(outcome);
		}
	}

	if (results.length === 0) return null;
	// If *any* rep was followed to the end, this game isn't a deviation —
	// but we still want its on-tree user moves for the WDL aggregate.
	if (results.some((r) => r.kind === 'followed')) {
		return wdlHits.length > 0 ? { wdlHits } : null;
	}

	type Divergent = Extract<PerRep, { ply: number }>;
	let best: Divergent | null = null;
	for (const r of results) {
		if (r.kind === 'followed') continue;
		if (!best || r.ply > best.ply) best = r;
	}
	if (!best) return null;
	const hits = wdlHits.length > 0 ? wdlHits : undefined;
	if (best.kind === 'mistake') return { mistake: best.record, wdlHits: hits };
	return { gap: best.record, wdlHits: hits };
}

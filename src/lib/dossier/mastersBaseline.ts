/**
 * Masters Baseline: a directional reference pool of strong-player games
 * matching the user's actual opening repertoire.
 *
 * For each (opening family, user-colour) pair where the user has played
 * enough games, we:
 *   1. Pick a representative position the user reaches in that family at
 *      ~move 4–5 (deep enough to be the user's actual line; shallow enough
 *      that the masters DB still has games).
 *   2. Query Lichess masters explorer at that position, asking for the top N
 *      master games.
 *   3. Fetch each game's PGN, run it through `classifyGame()` from the side
 *      that matches the user's colour in that family. The output is a
 *      `ClassifiedGame[]` of "master playing the user's colour in the user's
 *      opening" — feed-compatible with every existing dossier module that
 *      consumes `ClassifiedGame[]`.
 *
 * The comparison is directional, not statistical — 10–20 master games per
 * family is thin. Modules that consume this should disclose the sample
 * sizes and frame the diff as "where masters deploy differently from you in
 * the same opening" rather than a quantitative baseline.
 */

import { parsePgn } from 'chessops/pgn';

import { fetchExplorer } from '$lib/explorer/client';
import { fetchMastersGamePgn } from '$lib/lichess/singleGame';
import type { LichessGameMeta } from '$lib/lichess/games';
import type { Color } from '$lib/types';

import { classifyGame, type ClassifiedGame } from './classify';
import { structuralChooserForOpeningName } from './openings';
import type { MastersBaselineCoverage } from '$lib/storage/mastersBaseline';

export interface MastersBaseline {
	games: ClassifiedGame[];
	coverage: MastersBaselineCoverage[];
	fetchedAt: number;
}

export interface MastersFetchProgress {
	done: number;
	total: number;
	currentFamily: string;
	currentColor: Color | null;
	gamesFetched: number;
}

export interface MastersBuildOpts {
	token: string;
	/** Top games to request per (family, colour). Lichess caps around 15. */
	perTarget?: number;
	/** Cap the number of (family, colour) targets we'll fetch — keeps the
	 *  initial fetch under a few minutes of wall-clock. Ignored when
	 *  `targets` is supplied (caller-picked targets are fetched in full). */
	maxTargets?: number;
	/** Skip families with fewer than this many user games. */
	minUserGames?: number;
	/** Inter-request pause (ms) — Lichess masters has tight rate limits. */
	requestDelayMs?: number;
	signal?: AbortSignal;
	onProgress?: (p: MastersFetchProgress) => void;
	/** Caller-supplied target list. When present, skips the auto-extract
	 *  + chooser filter and fetches exactly these (family, colour) pairs.
	 *  Used by the panel's "Configure" picker so the user can hand-pick
	 *  which buckets get fetched. */
	targets?: Target[];
}

export interface Target {
	family: string;
	color: Color;
	userGames: number;
	canonicalFen: string;
}

/** Candidate target plus a flag indicating whether the auto-filter would
 *  include it by default. Surfaced to the panel UI so the user can see
 *  which families *could* be fetched and override the default selection. */
export interface CandidateTarget extends Target {
	/** True when the structural chooser would auto-include this — i.e. the
	 *  user picked this opening (or both sides did). False for one-sided
	 *  faced cases like Caro-Kann as White. */
	autoIncluded: boolean;
}

interface ExplorerTopGame {
	id: string;
	white: { name: string; rating?: number };
	black: { name: string; rating?: number };
	winner?: 'white' | 'black';
	year?: number;
	month?: number | null;
}

export async function buildMastersBaseline(
	classified: ClassifiedGame[],
	opts: MastersBuildOpts
): Promise<MastersBaseline> {
	let capped: Target[];
	if (opts.targets && opts.targets.length > 0) {
		// Caller-picked: trust the input order and don't apply maxTargets.
		capped = opts.targets;
	} else {
		const targets = extractTargets(classified, opts.minUserGames ?? 4);
		targets.sort((a, b) => b.userGames - a.userGames);
		capped = targets.slice(0, opts.maxTargets ?? 12);
	}

	const games: ClassifiedGame[] = [];
	const coverage: MastersBaselineCoverage[] = [];
	let gamesFetched = 0;

	for (let i = 0; i < capped.length; i++) {
		if (opts.signal?.aborted) break;
		const t = capped[i];
		opts.onProgress?.({
			done: i,
			total: capped.length,
			currentFamily: t.family,
			currentColor: t.color,
			gamesFetched
		});
		const fetched = await fetchAndClassifyForTarget(t, opts);
		coverage.push({
			family: t.family,
			color: t.color,
			userGames: t.userGames,
			masterGames: fetched.length
		});
		games.push(...fetched);
		gamesFetched += fetched.length;
	}
	opts.onProgress?.({
		done: capped.length,
		total: capped.length,
		currentFamily: '',
		currentColor: null,
		gamesFetched
	});

	return { games, coverage, fetchedAt: Date.now() };
}

/** Stable hash of the targets list so we can detect repertoire drift. */
export function targetsHash(classified: ClassifiedGame[], minUserGames = 4): string {
	const targets = extractTargets(classified, minUserGames);
	targets.sort((a, b) => {
		if (a.color !== b.color) return a.color < b.color ? -1 : 1;
		return a.family < b.family ? -1 : 1;
	});
	const sig = targets.map((t) => `${t.color}|${t.family}|${t.userGames}`).join(';');
	return simpleHash(sig);
}

function simpleHash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

function extractTargets(classified: ClassifiedGame[], minUserGames: number): Target[] {
	return enumerateMastersCandidates(classified, minUserGames)
		.filter((c) => c.autoIncluded)
		.map(({ autoIncluded: _, ...t }) => t);
}

/**
 * List every (family, colour) pair the user has played at least
 * `minUserGames` times — both auto-included and "would-be-skipped"
 * cases. The panel UI uses this to render a picker so the user can see
 * the full set and override the default selection.
 *
 * Sorted by user game count (most-played first) so the picker reads
 * top-down in order of relevance.
 */
export function enumerateMastersCandidates(
	classified: ClassifiedGame[],
	minUserGames = 4
): CandidateTarget[] {
	// Group by (family-from-PGN, user-colour); collect candidate canonical FENs
	// from the user's 4th user-move (≈ move 4–5 in chess terms — past the
	// ECO-defining moves but before deep theory diverges).
	const groups = new Map<
		string,
		{ family: string; color: Color; userGames: number; fenCounts: Map<string, number> }
	>();
	for (const g of classified) {
		const family = parseFamily(g.openingName, g.eco);
		if (!family) continue;
		const key = `${g.color}|${family}`;
		let bucket = groups.get(key);
		if (!bucket) {
			bucket = { family, color: g.color, userGames: 0, fenCounts: new Map() };
			groups.set(key, bucket);
		}
		bucket.userGames += 1;
		// Pick the user's 4th user-move's fenBefore as the canonical position.
		// For white that's after 3 white + 3 black moves; for black that's
		// after 4 white + 3 black moves. Both depths match how Lichess masters
		// classifies a family, and most of the masters DB has data here.
		const sample = g.moves[3];
		if (sample?.fenBefore) {
			const fen = stripCounters(sample.fenBefore);
			bucket.fenCounts.set(fen, (bucket.fenCounts.get(fen) ?? 0) + 1);
		}
	}

	const candidates: CandidateTarget[] = [];
	for (const b of groups.values()) {
		if (b.userGames < minUserGames) continue;
		const canonical = pickMostCommon(b.fenCounts);
		if (!canonical) continue;
		// Auto-include rule: families the user actually *chose* (or where
		// both sides made a real structural choice — QGD, Albin, etc.).
		// True one-sided faced cases (e.g. Caro-Kann as White) get
		// `autoIncluded=false` so the picker leaves them unchecked by
		// default but still shows them so the user can override.
		const chooser = structuralChooserForOpeningName(b.family, null);
		const autoIncluded = chooser === 'either' || chooser === b.color;
		candidates.push({
			family: b.family,
			color: b.color,
			userGames: b.userGames,
			canonicalFen: canonical,
			autoIncluded
		});
	}
	candidates.sort((a, b) => b.userGames - a.userGames);
	return candidates;
}

function parseFamily(openingName: string | null, _eco: string | null): string | null {
	if (!openingName) return null;
	const trimmed = openingName.trim();
	if (!trimmed) return null;
	const colonIdx = trimmed.indexOf(':');
	return colonIdx < 0 ? trimmed : trimmed.slice(0, colonIdx).trim();
}

function pickMostCommon(counts: Map<string, number>): string | null {
	let best: string | null = null;
	let bestCount = 0;
	for (const [fen, count] of counts) {
		if (count > bestCount) {
			bestCount = count;
			best = fen;
		}
	}
	return best;
}

/** Strip halfmove/fullmove counters so two FENs that differ only in clock
 *  count as the same canonical position. */
function stripCounters(fen: string): string {
	const parts = fen.split(' ');
	if (parts.length < 4) return fen;
	return parts.slice(0, 4).join(' ');
}

async function fetchAndClassifyForTarget(
	target: Target,
	opts: MastersBuildOpts
): Promise<ClassifiedGame[]> {
	const perTarget = opts.perTarget ?? 12;
	const delay = opts.requestDelayMs ?? 250;

	let topGames: ExplorerTopGame[];
	try {
		const resp = await fetchExplorer({
			source: 'masters',
			fen: target.canonicalFen,
			topGames: perTarget,
			moves: 0,
			token: opts.token
		});
		topGames = (resp.topGames ?? []) as ExplorerTopGame[];
	} catch {
		return [];
	}
	if (topGames.length === 0) return [];

	const games: ClassifiedGame[] = [];
	for (const tg of topGames) {
		if (opts.signal?.aborted) break;
		await sleep(delay);
		try {
			const pgn = await fetchMastersGamePgn(tg.id, opts.token);
			const meta = pgnToMeta(tg.id, pgn, tg);
			const username =
				target.color === 'white' ? meta.players.white.user?.name : meta.players.black.user?.name;
			if (!username) continue;
			const cg = classifyGame(meta, username);
			if (cg) games.push(cg);
		} catch {
			// Skip individual failures — one bad PGN shouldn't kill the whole fetch.
		}
	}
	return games;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function pgnToMeta(id: string, pgn: string, tg?: ExplorerTopGame): LichessGameMeta {
	const headers = parseHeaders(pgn);
	const whiteName = tg?.white.name ?? headers.get('White') ?? 'White';
	const blackName = tg?.black.name ?? headers.get('Black') ?? 'Black';
	const whiteElo = tg?.white.rating ?? toNum(headers.get('WhiteElo'));
	const blackElo = tg?.black.rating ?? toNum(headers.get('BlackElo'));
	const result = headers.get('Result') ?? '*';
	const winner = result === '1-0' ? 'white' : result === '0-1' ? 'black' : undefined;
	const dateStr = headers.get('Date') ?? headers.get('UTCDate') ?? '';
	const createdAt =
		parsePgnDate(dateStr) ?? (tg?.year ? Date.UTC(tg.year, (tg.month ?? 1) - 1, 1) : 0);
	return {
		id,
		rated: true,
		variant: 'standard',
		// Masters games are over-the-board / classical; tag accordingly.
		speed: 'classical',
		createdAt,
		players: {
			white: { user: { name: whiteName }, rating: whiteElo },
			black: { user: { name: blackName }, rating: blackElo }
		},
		winner,
		pgn,
		status: result === '1/2-1/2' ? 'draw' : 'mate'
	};
}

function parseHeaders(pgn: string): Map<string, string> {
	const games = parsePgn(pgn);
	if (games.length === 0) return new Map();
	const map = new Map<string, string>();
	const h = games[0].headers;
	for (const [k, v] of h) map.set(k, v);
	return map;
}

function toNum(s: string | undefined): number | undefined {
	if (!s) return undefined;
	const n = Number(s);
	return Number.isFinite(n) ? n : undefined;
}

function parsePgnDate(s: string): number | null {
	if (!s) return null;
	// PGN dates: "YYYY.MM.DD" or "YYYY.MM.??" or "????.??.??"
	const m = s.match(/^(\d{4})\.(\d{2}|\?\?)\.(\d{2}|\?\?)$/);
	if (!m) return null;
	const year = Number(m[1]);
	const month = m[2] === '??' ? 0 : Number(m[2]) - 1;
	const day = m[3] === '??' ? 1 : Number(m[3]);
	if (!Number.isFinite(year)) return null;
	return Date.UTC(year, month, day);
}

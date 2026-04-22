#!/usr/bin/env node
/**
 * Compute an empirical baseline for the style fingerprint by sampling
 * games from a population of Lichess players, optionally restricted to a
 * rating window. Writes the result to src/lib/dossier/baseline.json as a
 * **bucket** appended to a buckets[] array — runtime can then pick the
 * bucket whose rating range best matches the user being analysed.
 *
 * Two sampling modes:
 *
 *  1. **Direct**: just sample games from the usernames you pass.
 *     Useful for an "elite play" anchor (top players).
 *
 *  2. **Snowball** (--snowball=true): walk one hop through opponents.
 *     For each seed user we fetch their games, then collect *their*
 *     opponents whose rating falls in [--rating-min, --rating-max].
 *     Then we sample games from those opponents. This produces a
 *     baseline at a target rating band without needing a directory of
 *     mid-rated players (Lichess has no public "random N-rated user"
 *     endpoint). Matchmaking does the work for us.
 *
 * Output: merges into src/lib/dossier/baseline.json. Each bucket is
 * uniquely keyed by (bucket, ratingMin, ratingMax) — re-running with
 * the same params overwrites; running with new params appends.
 *
 * Examples:
 *   # Snowball a 1400–1600 blitz baseline starting from a few seeds.
 *   node scripts/compute-dossier-baseline.mjs \
 *     --bucket=blitz --rating-min=1400 --rating-max=1600 \
 *     --usernames=Player1,Player2,Player3 \
 *     --snowball=true --max-users=40 --games-per-user=20
 *
 *   # Direct: GM blitz baseline (legacy mode, no snowball).
 *   node scripts/compute-dossier-baseline.mjs --bucket=blitz \
 *     --usernames=DrNykterstein,Hikaru,nz9 --games-per-user=100
 *
 * No Lichess token required — anonymous endpoint with rate-limit pause.
 *
 * NOTE: this script ships board-only logic inline so it doesn't have to
 * import the TS pipeline through tsx. Keep its feature definitions in
 * sync with src/lib/dossier/classify.ts and src/lib/dossier/demand.ts.
 *
 * NOTE: v2 peer benchmark fields (evalByPhaseColor, criticalMoments,
 * clockSpend) are NOT populated by this script — Stockfish WASM runs
 * only in the browser. v2 peer benchmarks are produced by the runtime
 * `calibrateBaseline()` in `src/lib/dossier/calibrate.ts` (opt-in via the
 * UI). Buckets emitted by this script leave the v2 fields unset, and
 * the runtime falls back to the eyeballed root defaults in
 * `baseline.json`.
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePgn, startingPosition } from 'chessops/pgn';
import { parseSan } from 'chessops/san';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../src/lib/dossier/baseline.json');

const args = parseArgs(process.argv.slice(2));
const bucket = args.bucket ?? 'blitz';
const seedUsernames = (args.usernames ?? '').split(',').filter(Boolean);
const gamesPerUser = Number(args['games-per-user'] ?? 50);
const ratingMin = args['rating-min'] != null ? Number(args['rating-min']) : null;
const ratingMax = args['rating-max'] != null ? Number(args['rating-max']) : null;
const snowball = args.snowball === 'true' || args.snowball === '1';
const maxUsers = Number(args['max-users'] ?? 40);
const seedGamesForSnowball = Number(args['seed-games'] ?? 30);

if (seedUsernames.length === 0) {
	console.error('Provide --usernames=name1,name2,…');
	process.exit(1);
}

const requireRatingFilter = ratingMin != null || ratingMax != null;
const inBand = (r) => {
	if (r == null) return false;
	if (ratingMin != null && r < ratingMin) return false;
	if (ratingMax != null && r > ratingMax) return false;
	return true;
};

let userPool = seedUsernames;

if (snowball) {
	if (!requireRatingFilter) {
		console.error('--snowball=true requires --rating-min and/or --rating-max.');
		process.exit(1);
	}
	console.error(
		`Snowballing from ${seedUsernames.length} seeds → opponents in [${ratingMin ?? '−∞'}, ${ratingMax ?? '+∞'}] @ ${bucket}…`
	);
	const collected = new Map(); // username -> rating (for diagnostics)
	for (const seed of seedUsernames) {
		const games = await fetchUserGames(seed, seedGamesForSnowball, bucket);
		for (const g of games) {
			const opponents = extractOpponents(g, seed);
			for (const o of opponents) {
				if (!inBand(o.rating)) continue;
				if (collected.has(o.name)) continue;
				collected.set(o.name, o.rating);
				if (collected.size >= maxUsers) break;
			}
			if (collected.size >= maxUsers) break;
		}
		if (collected.size >= maxUsers) break;
		await sleep(800);
	}
	userPool = [...collected.keys()];
	if (userPool.length === 0) {
		console.error('Snowball found 0 users in the rating band — widen the band or add seeds.');
		process.exit(1);
	}
	console.error(`Snowball collected ${userPool.length} users in the band.`);
}

console.error(
	`Sampling ${gamesPerUser} games from each of ${userPool.length} users in bucket=${bucket}…`
);

const acc = {
	totalMoves: 0,
	forcing: 0,
	capture: 0,
	pawnPlay: 0,
	queenside: 0,
	games: 0,
	castledGames: 0,
	tensioned: 0,
	released: 0,
	created: 0,
	// Per-game axis samples — one row per peer game. Used to compute
	// population SD so downstream code can report z-scores against this
	// bucket instead of naked deltas.
	perGame: []
};

for (const user of userPool) {
	const lichessGames = await fetchUserGames(user, gamesPerUser, bucket);
	console.error(`  ${user}: ${lichessGames.length} games`);
	for (const game of lichessGames) {
		processGame(game, user, acc);
	}
	await sleep(800);
}

const totalMoves = acc.totalMoves;
const games = acc.games;
const newBucket = {
	bucket,
	ratingMin,
	ratingMax,
	mode: snowball ? 'snowball' : 'direct',
	seedUsers: seedUsernames,
	sampledUsers: userPool.length,
	games,
	totalMoves,
	axes: {
		forcing: round(acc.forcing / totalMoves),
		capture: round(acc.capture / totalMoves),
		pawnPlay: round(acc.pawnPlay / totalMoves),
		queenside: round(acc.queenside / totalMoves),
		earlyCastle: round(acc.castledGames / games)
	},
	axesSd: {
		forcing: round(sdOf(acc.perGame.map((r) => r.forcing))),
		capture: round(sdOf(acc.perGame.map((r) => r.capture))),
		pawnPlay: round(sdOf(acc.perGame.map((r) => r.pawnPlay))),
		queenside: round(sdOf(acc.perGame.map((r) => r.queenside))),
		earlyCastle: round(sdOf(acc.perGame.map((r) => r.earlyCastle)))
	},
	tension: {
		releaseRate: acc.tensioned > 0 ? round(acc.released / acc.tensioned) : 0,
		creationRate: round(acc.created / totalMoves)
	},
	tensionSd: {
		releaseRate: round(sdOf(acc.perGame.map((r) => r.releaseRate))),
		creationRate: round(sdOf(acc.perGame.map((r) => r.creationRate)))
	},
	computedAt: new Date().toISOString()
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
mergeBucket(OUT_PATH, newBucket);
console.error(`\nWrote bucket to ${OUT_PATH}`);
console.log(JSON.stringify(newBucket, null, 2));

// ─── helpers ──────────────────────────────────────────────────────────

async function fetchUserGames(user, max, perfType) {
	const url = new URL(`https://lichess.org/api/games/user/${encodeURIComponent(user)}`);
	url.searchParams.set('max', String(max));
	url.searchParams.set('rated', 'true');
	url.searchParams.set('perfType', perfType);
	url.searchParams.set('pgnInJson', 'true');
	url.searchParams.set('moves', 'true');
	const res = await fetch(url, { headers: { Accept: 'application/x-ndjson' } });
	if (!res.ok) {
		console.error(`  ${user}: HTTP ${res.status} — skipping`);
		return [];
	}
	const text = await res.text();
	const lines = text.split('\n').filter(Boolean);
	const out = [];
	for (const line of lines) {
		try {
			out.push(JSON.parse(line));
		} catch {
			/* skip */
		}
	}
	return out;
}

function extractOpponents(game, seedName) {
	const lower = seedName.toLowerCase();
	const w = game.players?.white?.user?.name;
	const b = game.players?.black?.user?.name;
	const wr = game.players?.white?.rating;
	const br = game.players?.black?.rating;
	if (w?.toLowerCase() === lower && b) return [{ name: b, rating: br }];
	if (b?.toLowerCase() === lower && w) return [{ name: w, rating: wr }];
	return [];
}

function processGame(game, user, acc) {
	const lower = user.toLowerCase();
	const userIsWhite = game.players?.white?.user?.name?.toLowerCase() === lower;
	const userIsBlack = game.players?.black?.user?.name?.toLowerCase() === lower;
	if (!userIsWhite && !userIsBlack) return;
	const userColor = userIsWhite ? 'white' : 'black';
	if (game.variant && game.variant !== 'standard') return;

	const parsed = parsePgn(game.pgn ?? '');
	if (parsed.length === 0) return;
	const startR = startingPosition(parsed[0].headers);
	if (startR.isErr) return;
	const pos = startR.value;
	acc.games += 1;
	let castledThisGame = false;
	// Per-game counters — rolled up into `perGame` at end of game.
	let gForcing = 0;
	let gCapture = 0;
	let gPawn = 0;
	let gQueen = 0;
	let gMoves = 0;
	let gTensioned = 0;
	let gReleased = 0;
	let gCreated = 0;

	for (const node of parsed[0].moves.mainline()) {
		const move = parseSan(pos, node.san);
		if (!move) break;
		const isUserTurn = pos.turn === userColor;
		if (isUserTurn && 'from' in move) {
			const piece = pos.board.get(move.from);
			if (piece) {
				const target = pos.board.get(move.to);
				const isCapture = !!target;
				const isPawn = piece.role === 'pawn';
				const tBefore = countTension(pos);
				const after = pos.clone();
				after.play(move);
				const isCheck = after.isCheck();
				const tAfter = countTension(after);
				acc.totalMoves += 1;
				gMoves += 1;
				if (isCapture || isCheck) {
					acc.forcing += 1;
					gForcing += 1;
				}
				if (isCapture) {
					acc.capture += 1;
					gCapture += 1;
				}
				if (isPawn) {
					acc.pawnPlay += 1;
					gPawn += 1;
				}
				if ((move.to & 7) <= 3) {
					acc.queenside += 1;
					gQueen += 1;
				}
				if (node.san.startsWith('O-O') && pos.fullmoves <= 20) castledThisGame = true;
				if (tBefore > 0) {
					acc.tensioned += 1;
					gTensioned += 1;
					if (tAfter < tBefore) {
						acc.released += 1;
						gReleased += 1;
					}
				}
				if (tAfter > tBefore && tBefore === 0) {
					acc.created += 1;
					gCreated += 1;
				}
			}
		}
		pos.play(move);
	}
	if (castledThisGame) acc.castledGames += 1;
	if (gMoves > 0) {
		acc.perGame.push({
			forcing: gForcing / gMoves,
			capture: gCapture / gMoves,
			pawnPlay: gPawn / gMoves,
			queenside: gQueen / gMoves,
			earlyCastle: castledThisGame ? 1 : 0,
			releaseRate: gTensioned > 0 ? gReleased / gTensioned : 0,
			creationRate: gCreated / gMoves
		});
	}
}

function sdOf(xs) {
	if (xs.length < 2) return 0;
	let sum = 0;
	for (const x of xs) sum += x;
	const mean = sum / xs.length;
	let sq = 0;
	for (const x of xs) sq += (x - mean) * (x - mean);
	return Math.sqrt(sq / xs.length);
}

function mergeBucket(path, newBucket) {
	let existing;
	try {
		existing = JSON.parse(readFileSync(path, 'utf-8'));
	} catch {
		existing = null;
	}

	// First-ever empirical run: keep legacy top-level fields as a default
	// fallback bucket so the runtime still has axes/tension if no rating
	// match is found.
	if (!existing || !Array.isArray(existing.buckets)) {
		const fallbackAxes = existing?.axes ?? newBucket.axes;
		const fallbackTension = existing?.tension ?? newBucket.tension;
		existing = {
			source: 'empirical',
			axes: fallbackAxes,
			tension: fallbackTension,
			buckets: [],
			computedAt: new Date().toISOString()
		};
	}

	existing.buckets = existing.buckets.filter(
		(b) =>
			!(
				b.bucket === newBucket.bucket &&
				b.ratingMin === newBucket.ratingMin &&
				b.ratingMax === newBucket.ratingMax
			)
	);
	existing.buckets.push(newBucket);
	existing.buckets.sort(
		(a, b) =>
			(a.bucket ?? '').localeCompare(b.bucket ?? '') || (a.ratingMin ?? -1) - (b.ratingMin ?? -1)
	);
	existing.source = 'empirical';
	existing.computedAt = new Date().toISOString();
	writeFileSync(path, JSON.stringify(existing, null, 2));
}

function round(x) {
	return Math.round(x * 1000) / 1000;
}

function countTension(pos) {
	let pairs = 0;
	for (const sq of pos.board.pawn.intersect(pos.board.white)) {
		const f = sq & 7;
		const r = sq >> 3;
		if (r >= 7) continue;
		for (const df of [-1, 1]) {
			const tf = f + df;
			if (tf < 0 || tf > 7) continue;
			const tsq = tf + (r + 1) * 8;
			const t = pos.board.get(tsq);
			if (t?.role === 'pawn' && t.color === 'black') pairs += 1;
		}
	}
	return pairs;
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = a.match(/^--([^=]+)=(.*)$/);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

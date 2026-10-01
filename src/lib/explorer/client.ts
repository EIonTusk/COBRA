/**
 * Lichess opening explorer client.
 *
 * As of March 2026 the explorer endpoint requires a Lichess API token (any
 * personal token works — no special scope needed). Users paste one in Settings;
 * we send it as `Authorization: Bearer <token>`. Without a token the panel
 * shows a setup message instead of making requests.
 *
 * Lichess rate-limits the explorer hard (issue #88), so every request goes
 * through one scheduler here:
 *  - Cache: in-memory LRU plus a 24 h IndexedDB cache, keyed by position —
 *    the FEN's move counters are ignored, so transpositions and returning to
 *    a position reuse the result. Standard Lichess-database queries are
 *    fetched once at the largest size any caller uses and trimmed per
 *    caller, so the builder panel, board hints, missing-moves scan and
 *    coverage share one request per position.
 *  - Identical requests in flight or queued share one network call.
 *  - One request at a time, at least MIN_GAP_MS apart; `foreground`
 *    requests (what the user is looking at) go ahead of queued
 *    `background` ones (scans, probes). A queued request whose callers all
 *    aborted is dropped before it's sent.
 *  - A 429 starts a 60 s cooldown and fails everything queued; nothing is
 *    sent until it ends.
 */

export interface ExplorerMove {
	uci: string;
	san: string;
	white: number;
	draws: number;
	black: number;
	averageRating?: number;
	/**
	 * Lichess tags a move with an opening if it transitions the position
	 * into a named opening / variation (i.e. it has an ECO code of its own).
	 * Present only on such "main-line" moves — used to gate the MAIN badge.
	 */
	opening?: { eco: string; name: string } | null;
}

export interface ExplorerResponse {
	white: number;
	draws: number;
	black: number;
	moves: ExplorerMove[];
	topGames?: TopGameEntry[];
	recentGames?: unknown[];
	opening?: { eco: string; name: string } | null;
	/** /player returns this while indexing the user's games. */
	queuePosition?: number;
}

export interface ExplorerQuery {
	fen: string;
	/** Optional UCI moves to play from the FEN before sampling stats. */
	play?: string[];
	speeds?: string[];
	ratings?: number[];
	moves?: number;
	token?: string;
	/** Which Lichess explorer dataset to query. */
	source?: 'lichess' | 'masters' | 'player';
	/** For source='player': the Lichess username to filter to. */
	player?: string;
	/** For source='player': which colour the player had. */
	playerColor?: 'white' | 'black';
	/** For any source: include topGames entries in the response. */
	topGames?: number;
}

export interface TopGameEntry {
	id: string;
	uci: string;
	winner?: 'white' | 'black';
	white: { name: string; rating?: number };
	black: { name: string; rating?: number };
	year?: number;
	month?: number | null;
	speed?: string;
}

const LICHESS_URL = 'https://explorer.lichess.ovh/lichess';
const MASTERS_URL = 'https://explorer.lichess.ovh/masters';
const PLAYER_URL = 'https://explorer.lichess.ovh/player';
const CACHE_CAP = 300;
const cache = new Map<string, ExplorerResponse>();

// Persistent cache TTL. Explorer results are statistical — a day-stale read
// is perfectly fine.
const IDB_TTL_MS = 24 * 60 * 60 * 1000;
let idbPrunedAt = 0;

/** Minimum spacing between two network requests to the explorer. */
export const MIN_GAP_MS = 350;
/**
 * Spacing before a background request: priority only decides order, this
 * also caps how fast scans and probes can spend the rate limit.
 */
export const BACKGROUND_GAP_MS = 1000;
/** Moves fetched for standard Lichess queries; callers get their own slice. */
const SHARED_MOVES = 30;
/** Lichess's own default when `moves` isn't sent. */
const DEFAULT_MOVES = 12;

let cooldownUntil = 0;

export class ExplorerRateLimited extends Error {
	constructor(public cooldownMs: number) {
		super(`Lichess explorer rate-limited for ${cooldownMs}ms`);
	}
}

export class ExplorerAuthRequired extends Error {
	constructor() {
		super('Lichess explorer requires a personal API token.');
	}
}

export interface FetchOptions {
	/**
	 * `foreground` (default): the user is waiting on it. `background`: scans
	 * and probes that should yield to foreground requests.
	 */
	priority?: 'foreground' | 'background';
	/** Abort to drop the request if it hasn't been sent yet. */
	signal?: AbortSignal;
}

/**
 * Standard Lichess-database move lists are shared across callers: fetched
 * at SHARED_MOVES and sliced. Other sources/shapes are fetched as asked.
 */
function isShared(q: ExplorerQuery): boolean {
	return (
		(q.source ?? 'lichess') === 'lichess' &&
		!q.topGames &&
		(q.moves === undefined || q.moves <= SHARED_MOVES)
	);
}

/** The query actually sent: shared queries ask for SHARED_MOVES. */
function wireQuery(q: ExplorerQuery): ExplorerQuery {
	return isShared(q) ? { ...q, moves: SHARED_MOVES } : q;
}

/** Trim a shared response to what this caller asked for. */
function forCaller(q: ExplorerQuery, res: ExplorerResponse): ExplorerResponse {
	if (!isShared(q)) return res;
	const n = q.moves ?? DEFAULT_MOVES;
	return res.moves.length > n ? { ...res, moves: res.moves.slice(0, n) } : res;
}

/** Position part of a FEN: move counters don't change explorer statistics. */
function positionOf(fen: string): string {
	return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

/**
 * The cached result for this query, if one is already in memory — lets a UI
 * show a position it has seen before instantly, without waiting out a
 * debounce. Doesn't touch the network or IndexedDB.
 */
export function peekExplorer(query: ExplorerQuery): ExplorerResponse | null {
	const hit = cache.get(keyOf(wireQuery(query)));
	return hit ? forCaller(query, hit) : null;
}

interface Job {
	key: string;
	query: ExplorerQuery;
	background: boolean;
	/** Callers still waiting; 0 before sending → the job is dropped. */
	waiting: number;
	promise: Promise<ExplorerResponse>;
	resolve: (r: ExplorerResponse) => void;
	reject: (e: unknown) => void;
	started: boolean;
}

const queue: Job[] = [];
const jobsByKey = new Map<string, Job>();
let pumping = false;
let lastSentAt = 0;

export async function fetchExplorer(
	query: ExplorerQuery,
	opts: FetchOptions = {}
): Promise<ExplorerResponse> {
	const wire = wireQuery(query);
	const key = keyOf(wire);
	const fromMemory = (): ExplorerResponse | null => {
		const hit = cache.get(key);
		if (!hit) return null;
		cache.delete(key);
		cache.set(key, hit);
		return forCaller(query, hit);
	};
	const memo = fromMemory();
	if (memo) return memo;

	// An identical request already queued or in flight: join it rather than
	// look it up again (a request can finish while the IndexedDB read below
	// is pending, so both checks run again after it).
	if (!jobsByKey.has(key)) {
		const persisted = await readPersistedCache(key);
		if (persisted) {
			store(key, persisted);
			return forCaller(query, persisted);
		}
		const late = fromMemory();
		if (late) return late;
	}

	if (!query.token) {
		throw new ExplorerAuthRequired();
	}
	if (Date.now() < cooldownUntil) {
		throw new ExplorerRateLimited(cooldownUntil - Date.now());
	}

	let job = jobsByKey.get(key);
	if (!job) {
		let resolve!: (r: ExplorerResponse) => void;
		let reject!: (e: unknown) => void;
		const promise = new Promise<ExplorerResponse>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		// Callers that abort get their own rejection; the shared promise may
		// still settle later with nobody listening.
		promise.catch(() => undefined);
		job = {
			key,
			query: wire,
			background: true,
			waiting: 0,
			promise,
			resolve,
			reject,
			started: false
		};
		jobsByKey.set(key, job);
		queue.push(job);
	}
	// Any foreground caller promotes a shared job.
	if (opts.priority !== 'background') job.background = false;
	job.waiting++;
	void pump();

	const mine = job;
	const signal = opts.signal;
	if (!signal) return mine.promise.then((r) => forCaller(query, r));
	if (signal.aborted) {
		release(mine);
		throw abortError();
	}
	return new Promise<ExplorerResponse>((resolve, reject) => {
		const onAbort = () => {
			release(mine);
			reject(abortError());
		};
		signal.addEventListener('abort', onAbort, { once: true });
		mine.promise.then(
			(r) => {
				signal.removeEventListener('abort', onAbort);
				resolve(forCaller(query, r));
			},
			(e) => {
				signal.removeEventListener('abort', onAbort);
				reject(e);
			}
		);
	});
}

function abortError(): DOMException {
	return new DOMException('Explorer request aborted', 'AbortError');
}

/** A caller stopped waiting; drop the job if nobody is left and it's unsent. */
function release(job: Job): void {
	job.waiting = Math.max(0, job.waiting - 1);
	if (job.waiting > 0 || job.started) return;
	const i = queue.indexOf(job);
	if (i >= 0) queue.splice(i, 1);
	if (jobsByKey.get(job.key) === job) jobsByKey.delete(job.key);
	job.reject(abortError());
}

function nextJob(): Job | undefined {
	const i = queue.findIndex((j) => !j.background);
	return queue.splice(i >= 0 ? i : 0, 1)[0];
}

async function pump(): Promise<void> {
	if (pumping) return;
	pumping = true;
	try {
		while (queue.length > 0) {
			const wait = lastSentAt + MIN_GAP_MS - Date.now();
			if (wait > 0) await new Promise((r) => setTimeout(r, wait));
			// Only background work queued: space it out further, re-checking so
			// a foreground request arriving meanwhile isn't held back.
			if (!queue.some((j) => !j.background)) {
				const bgWait = lastSentAt + BACKGROUND_GAP_MS - Date.now();
				if (bgWait > 0) {
					await new Promise((r) => setTimeout(r, Math.min(bgWait, 100)));
					continue;
				}
			}
			// Pick after waiting, so a foreground request that arrived during
			// the gap goes first.
			const job = nextJob();
			if (!job) break;
			if (Date.now() < cooldownUntil) {
				failJob(job, new ExplorerRateLimited(cooldownUntil - Date.now()));
				continue;
			}
			job.started = true;
			lastSentAt = Date.now();
			try {
				job.resolve(await send(job));
			} catch (e) {
				if (e instanceof ExplorerRateLimited) {
					// Everything queued would fail the same way.
					failJob(job, e);
					for (const j of queue.splice(0)) failJob(j, e);
					continue;
				}
				failJob(job, e);
				continue;
			}
			if (jobsByKey.get(job.key) === job) jobsByKey.delete(job.key);
		}
	} finally {
		pumping = false;
	}
}

function failJob(job: Job, e: unknown): void {
	if (jobsByKey.get(job.key) === job) jobsByKey.delete(job.key);
	job.reject(e);
}

async function send(job: Job): Promise<ExplorerResponse> {
	const q = job.query;
	const res = await fetch(buildUrl(q), {
		headers: { Accept: 'application/json', Authorization: `Bearer ${q.token}` }
	});
	if (res.status === 401) throw new ExplorerAuthRequired();
	if (res.status === 429) {
		cooldownUntil = Date.now() + 60_000;
		throw new ExplorerRateLimited(60_000);
	}
	if (!res.ok) throw new Error(`Lichess explorer: HTTP ${res.status}`);
	const body = (await res.json()) as ExplorerResponse;
	store(job.key, body);
	void writePersistedCache(job.key, body);
	return body;
}

function store(key: string, value: ExplorerResponse): void {
	if (cache.size >= CACHE_CAP) {
		const first = cache.keys().next().value;
		if (first !== undefined) cache.delete(first);
	}
	cache.set(key, value);
}

function buildUrl(q: ExplorerQuery): string {
	const base =
		q.source === 'masters' ? MASTERS_URL : q.source === 'player' ? PLAYER_URL : LICHESS_URL;
	const params = new URLSearchParams();
	params.set('variant', 'standard');
	params.set('fen', q.fen);
	if (q.play?.length) params.set('play', q.play.join(','));
	if (q.source === 'player') {
		if (q.player) params.set('player', q.player);
		if (q.playerColor) params.set('color', q.playerColor);
		if (q.speeds?.length) params.set('speeds', q.speeds.join(','));
		if (q.ratings?.length) params.set('modes', 'rated');
	} else if (q.source === 'masters') {
		// /masters only accepts play/since/until/moves/topGames — no player
		// filter. If you need a specific master's games, use /player with
		// their Lichess handle.
	} else {
		if (q.speeds?.length) params.set('speeds', q.speeds.join(','));
		if (q.ratings?.length) params.set('ratings', q.ratings.join(','));
	}
	if (q.moves !== undefined) params.set('moves', String(q.moves));
	params.set('topGames', String(q.topGames ?? 0));
	params.set('recentGames', '0');
	return `${base}?${params.toString()}`;
}

function keyOf(q: ExplorerQuery): string {
	return [
		'v2',
		q.source ?? 'lichess',
		q.player ?? '',
		q.playerColor ?? '',
		positionOf(q.fen),
		(q.play ?? []).join(','),
		(q.speeds ?? []).join(','),
		(q.ratings ?? []).join(','),
		q.moves ?? '',
		q.topGames ?? 0
	].join('|');
}

export function explorerCooldownMs(): number {
	return Math.max(0, cooldownUntil - Date.now());
}

// Loaded lazily (keeps IndexedDB out of this module's import graph), once.
let dbModule: Promise<typeof import('$lib/storage/db')> | null = null;
function storageModule(): Promise<typeof import('$lib/storage/db')> {
	dbModule ??= import('$lib/storage/db');
	return dbModule;
}

async function readPersistedCache(key: string): Promise<ExplorerResponse | null> {
	try {
		const { getDB, pruneExplorerCache } = await storageModule();
		const db = await getDB();
		const row = await db.get('explorer_stats', key);
		if (!row) return null;
		if (Date.now() - row.fetchedAt > IDB_TTL_MS) return null;
		// Prune old rows at most once an hour.
		if (Date.now() - idbPrunedAt > 60 * 60 * 1000) {
			idbPrunedAt = Date.now();
			void pruneExplorerCache(IDB_TTL_MS);
		}
		return row.data as ExplorerResponse;
	} catch {
		return null;
	}
}

async function writePersistedCache(key: string, value: ExplorerResponse): Promise<void> {
	try {
		const { getDB } = await storageModule();
		const db = await getDB();
		await db.put('explorer_stats', { key, fetchedAt: Date.now(), data: value });
	} catch {
		/* best-effort */
	}
}

/** Test-only: forget cache, queue and cooldown. */
export function __resetExplorerClientForTests(): void {
	cache.clear();
	queue.length = 0;
	jobsByKey.clear();
	cooldownUntil = 0;
	lastSentAt = 0;
	pumping = false;
}

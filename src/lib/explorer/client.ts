/**
 * Lichess opening explorer client.
 *
 * As of March 2026 the explorer endpoint requires a Lichess API token (any
 * personal token works — no special scope needed). Users paste one in Settings;
 * we send it as `Authorization: Bearer <token>`. Without a token the panel
 * shows a setup message instead of making requests.
 *
 * We keep a strict single-flight queue with a 60 s cooldown after any 429,
 * plus a small in-memory LRU cache keyed by normalized FEN. Service worker
 * runtime-caching handles offline replay.
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
const CACHE_CAP = 100;
const cache = new Map<string, ExplorerResponse>();

// Persistent cache TTL. Explorer results are statistical — a day-stale read
// is perfectly fine.
const IDB_TTL_MS = 24 * 60 * 60 * 1000;
let idbPrunedAt = 0;

let inflight: Promise<unknown> | null = null;
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

export async function fetchExplorer(query: ExplorerQuery): Promise<ExplorerResponse> {
	const cacheKey = keyOf(query);
	const cached = cache.get(cacheKey);
	if (cached) {
		cache.delete(cacheKey);
		cache.set(cacheKey, cached);
		return cached;
	}

	const persisted = await readPersistedCache(cacheKey);
	if (persisted) {
		store(cacheKey, persisted);
		return persisted;
	}

	if (!query.token) {
		throw new ExplorerAuthRequired();
	}

	if (Date.now() < cooldownUntil) {
		throw new ExplorerRateLimited(cooldownUntil - Date.now());
	}

	if (inflight) {
		try {
			await inflight;
		} catch {
			/* ignore previous failure */
		}
	}

	const url = buildUrl(query);
	const headers: Record<string, string> = {
		Accept: 'application/json',
		Authorization: `Bearer ${query.token}`
	};
	const p = fetch(url, { headers })
		.then(async (res) => {
			if (res.status === 401) {
				throw new ExplorerAuthRequired();
			}
			if (res.status === 429) {
				cooldownUntil = Date.now() + 60_000;
				throw new ExplorerRateLimited(60_000);
			}
			if (!res.ok) {
				throw new Error(`Lichess explorer: HTTP ${res.status}`);
			}
			const body = (await res.json()) as ExplorerResponse;
			store(cacheKey, body);
			void writePersistedCache(cacheKey, body);
			return body;
		})
		.finally(() => {
			if (inflight === p) inflight = null;
		});

	inflight = p;
	return p;
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
		q.source ?? 'lichess',
		q.player ?? '',
		q.playerColor ?? '',
		q.fen,
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

async function readPersistedCache(key: string): Promise<ExplorerResponse | null> {
	try {
		const { getDB, pruneExplorerCache } = await import('$lib/storage/db');
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
		const { getDB } = await import('$lib/storage/db');
		const db = await getDB();
		await db.put('explorer_stats', { key, fetchedAt: Date.now(), data: value });
	} catch {
		/* best-effort */
	}
}

// Simple debounce utility for callers who change positions rapidly.
export function debounced<A extends unknown[], R>(
	fn: (...args: A) => Promise<R>,
	delayMs: number
): (...args: A) => Promise<R> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pendingResolve: ((r: R) => void) | null = null;
	let pendingReject: ((e: unknown) => void) | null = null;
	return (...args: A) => {
		if (timer) {
			clearTimeout(timer);
			if (pendingReject) {
				const r = pendingReject;
				pendingReject = null;
				pendingResolve = null;
				r(new DOMException('Superseded', 'AbortError'));
			}
		}
		return new Promise<R>((resolve, reject) => {
			pendingResolve = resolve;
			pendingReject = reject;
			timer = setTimeout(() => {
				fn(...args)
					.then((r) => pendingResolve?.(r))
					.catch((e) => pendingReject?.(e));
			}, delayMs);
		});
	};
}

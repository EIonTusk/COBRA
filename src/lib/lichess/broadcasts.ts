/**
 * Lichess Broadcasts API client. Broadcasts cover OTB events (Candidates,
 * Tata Steel, Norway Chess, Olympiad, EICC, …) so they're the public path
 * to games by players who don't have Lichess accounts — Ding Liren,
 * Caruana, Kasparov if he plays a commentary game, etc.
 */

export interface BroadcastListEntry {
	tour: {
		id: string;
		name: string;
		slug?: string;
		tier?: number;
		dates?: number[];
		createdAt?: number;
	};
	rounds: Array<{
		id: string;
		name: string;
		finished?: boolean;
		startsAt?: number;
	}>;
}

/**
 * List recent / ongoing official broadcasts. Server streams NDJSON but we
 * materialise the whole list for ease of use; `nb` caps the count.
 */
export async function fetchBroadcastsList(opts: {
	nb?: number;
	token?: string;
	signal?: AbortSignal;
}): Promise<BroadcastListEntry[]> {
	const params = new URLSearchParams();
	if (opts.nb) params.set('nb', String(opts.nb));
	const headers: Record<string, string> = { Accept: 'application/x-ndjson' };
	if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
	const res = await fetch(`https://lichess.org/api/broadcast?${params.toString()}`, {
		headers,
		signal: opts.signal
	});
	if (res.status === 429) throw new Error('Rate limited by Lichess.');
	if (!res.ok) throw new Error(`Broadcasts list: HTTP ${res.status}`);
	const text = await res.text();
	const out: BroadcastListEntry[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as BroadcastListEntry);
		} catch {
			/* skip malformed line */
		}
	}
	return out;
}

/** Export every game of a broadcast tournament as a multi-game PGN string. */
export async function fetchBroadcastPgn(
	tourId: string,
	opts: { token?: string; signal?: AbortSignal }
): Promise<string> {
	const headers: Record<string, string> = { Accept: 'application/x-chess-pgn' };
	if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
	const res = await fetch(`https://lichess.org/api/broadcast/${encodeURIComponent(tourId)}.pgn`, {
		headers,
		signal: opts.signal
	});
	if (res.status === 429) throw new Error('Rate limited by Lichess.');
	if (res.status === 404) throw new Error(`Broadcast "${tourId}" not found.`);
	if (!res.ok) throw new Error(`Broadcast PGN: HTTP ${res.status}`);
	return await res.text();
}

/**
 * FIDE player, as returned by `/api/fide/player?q=…`. Rating fields are the
 * numbers shown on the Lichess FIDE pages; missing ratings come through as
 * undefined rather than zero.
 */
export interface FidePlayer {
	id: number;
	name: string;
	federation?: string;
	year?: number;
	title?: string;
	standard?: number;
	rapid?: number;
	blitz?: number;
	inactive?: boolean;
}

/**
 * Search Lichess's FIDE-player index. Backs the autobuild's player picker:
 * the user types "ding", we hand the resulting list straight into a select.
 * The endpoint mirrors the `/fide?q=` page but returns JSON.
 */
export async function searchFidePlayers(opts: {
	query: string;
	token?: string;
	signal?: AbortSignal;
}): Promise<FidePlayer[]> {
	const q = opts.query.trim();
	if (!q) return [];
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
	const res = await fetch(`https://lichess.org/api/fide/player?q=${encodeURIComponent(q)}`, {
		headers,
		signal: opts.signal
	});
	if (res.status === 429) throw new Error('Rate limited by Lichess.');
	if (!res.ok) throw new Error(`FIDE search: HTTP ${res.status}`);
	return (await res.json()) as FidePlayer[];
}

/**
 * Search broadcasts for ones featuring a given player / query string. Wraps
 * `GET /api/broadcast/search?q=…` — paginated JSON (not NDJSON like the
 * listing endpoint). We accumulate pages up to `maxPages` so the autobuild
 * can see more than the default page of 24. CORS-enabled (/api/*), so this
 * is the workable substitute for the CORS-blocked `/fide/<id>/<slug>` HTML
 * scrape.
 */
export async function searchBroadcastsByPlayer(opts: {
	query: string;
	maxPages?: number;
	token?: string;
	signal?: AbortSignal;
}): Promise<BroadcastListEntry[]> {
	const q = opts.query.trim();
	if (!q) return [];
	const maxPages = opts.maxPages ?? 3;
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

	const out: BroadcastListEntry[] = [];
	let page = 1;
	while (page <= maxPages) {
		const url = `https://lichess.org/api/broadcast/search?q=${encodeURIComponent(q)}&page=${page}`;
		const res = await fetch(url, { headers, signal: opts.signal });
		if (res.status === 429) throw new Error('Rate limited by Lichess.');
		if (!res.ok) throw new Error(`Broadcast search: HTTP ${res.status}`);
		const body = (await res.json()) as {
			currentPageResults?: BroadcastListEntry[];
			nextPage?: number | null;
		};
		const rows = body.currentPageResults ?? [];
		out.push(...rows);
		if (!body.nextPage) break;
		page = body.nextPage;
	}
	return out;
}

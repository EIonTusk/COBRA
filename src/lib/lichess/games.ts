/**
 * Stream one user's Lichess games as NDJSON. Lichess returns a ~50-game
 * page by default and streams the rest as they're fetched from their
 * database — consumers iterate incrementally and can display progress.
 */

export interface LichessPlayer {
	user?: { name: string; id?: string; title?: string | null };
	rating?: number;
}

export interface LichessGameMeta {
	id: string;
	rated: boolean;
	variant: string;
	speed: string;
	createdAt: number;
	players: {
		white: LichessPlayer;
		black: LichessPlayer;
	};
	winner?: 'white' | 'black';
	pgn: string;
	status?: string;
}

export interface StreamOpts {
	max?: number;
	token: string;
	rated?: boolean;
	signal?: AbortSignal;
	/** Only standard chess, never variants. */
	variant?: 'standard' | 'all';
	/** Include games played at or after this timestamp (ms since epoch). */
	since?: number;
	/**
	 * Ask Lichess to inline `[%eval]` comments per ply when the game has
	 * been analysed on the site. Adds no extra request cost. Opt-in so
	 * callers that don't need evals don't pay the PGN-size increase.
	 */
	evals?: boolean;
}

export async function* streamUserGames(
	username: string,
	opts: StreamOpts
): AsyncGenerator<LichessGameMeta> {
	const params = new URLSearchParams({
		max: String(opts.max ?? 50),
		pgnInJson: 'true',
		moves: 'true',
		// `clocks=true` causes Lichess to embed `{ [%clk H:MM:SS] }` PGN
		// comments per move, which the style classifier reads to bucket
		// moves by remaining clock (panic-attack detector).
		clocks: 'true',
		evals: opts.evals ? 'true' : 'false',
		// `opening=true` makes Lichess include `[ECO]` and `[Opening]` tags
		// in the PGN, which the style classifier reads to bucket games by
		// opening family. chess.com PGN already ships these.
		opening: 'true',
		literate: 'false'
	});
	if (opts.rated !== undefined) params.set('rated', String(opts.rated));
	if (opts.variant === 'standard') params.set('perfType', 'bullet,blitz,rapid,classical');
	if (opts.since !== undefined) params.set('since', String(opts.since));

	const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`;
	const res = await fetch(url, {
		headers: {
			Accept: 'application/x-ndjson',
			Authorization: `Bearer ${opts.token}`
		},
		signal: opts.signal
	});
	if (res.status === 404) throw new Error(`Lichess user "${username}" not found.`);
	if (res.status === 429) throw new Error('Rate limited by Lichess. Wait a minute and retry.');
	if (!res.ok || !res.body) throw new Error(`Lichess API: HTTP ${res.status}`);

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let nl = buffer.indexOf('\n');
		while (nl !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (line) {
				try {
					yield JSON.parse(line) as LichessGameMeta;
				} catch {
					/* skip malformed */
				}
			}
			nl = buffer.indexOf('\n');
		}
	}
	const tail = buffer.trim();
	if (tail) {
		try {
			yield JSON.parse(tail) as LichessGameMeta;
		} catch {
			/* skip */
		}
	}
}

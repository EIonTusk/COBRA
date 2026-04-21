/**
 * Fetch a single Lichess game's PGN. Works without auth for public games,
 * but an access token lifts rate limits. Lichess game IDs are 8-char
 * alphanumeric; accept them raw, in a URL, or with a colour suffix.
 */

const ID_RE = /\b([a-zA-Z0-9]{8})\b/;

export function extractGameId(input: string): string | null {
	const m = input.trim().match(ID_RE);
	return m ? m[1] : null;
}

export async function fetchLichessGamePgn(idOrUrl: string, token?: string): Promise<string> {
	const id = extractGameId(idOrUrl);
	if (!id) throw new Error('Could not find a Lichess game id in that input.');
	const headers: Record<string, string> = {
		Accept: 'application/x-chess-pgn'
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(
		`https://lichess.org/game/export/${id}?pgnInJson=false&clocks=false&evals=false&literate=false`,
		{ headers }
	);
	if (res.status === 404) throw new Error(`Lichess game "${id}" not found.`);
	if (res.status === 429) throw new Error('Rate limited by Lichess.');
	if (!res.ok) throw new Error(`Lichess API: HTTP ${res.status}`);
	return await res.text();
}

/**
 * Poll-friendly variant of the PGN fetch, using the batch export endpoint
 * `POST /api/games/export/_ids`. This lives under `/api/` so Lichess sends
 * CORS headers consistently; when the requested game isn't available yet
 * (bot hasn't accepted, game still in progress, etc.) it returns a 200 with
 * an empty body instead of a 404 without CORS headers — which is what the
 * single-game export endpoint does and what was spamming the browser
 * console during spar-waiting polls.
 *
 * Returns the PGN string if Lichess included the game in the response, or
 * null when the endpoint responded 200 but the body was empty (= "not
 * ready yet"). Any other failure throws.
 */
export async function fetchLichessGamePgnIfReady(
	idOrUrl: string,
	token?: string
): Promise<string | null> {
	const id = extractGameId(idOrUrl);
	if (!id) throw new Error('Could not find a Lichess game id in that input.');
	const headers: Record<string, string> = {
		Accept: 'application/x-chess-pgn',
		'Content-Type': 'text/plain'
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(
		'https://lichess.org/api/games/export/_ids?pgnInJson=false&clocks=false&evals=false&literate=false',
		{ method: 'POST', headers, body: id }
	);
	if (res.status === 429) throw new Error('Rate limited by Lichess.');
	if (!res.ok) throw new Error(`Lichess API: HTTP ${res.status}`);
	const text = (await res.text()).trim();
	return text.length > 0 ? text : null;
}

/**
 * Fetch a single masters-DB game's PGN. Masters game ids are slugs like
 * `bogojubow-1927`, unrelated to Lichess's 8-char user game ids; they live
 * on the openingexplorer host under `/masters/pgn/{id}`.
 */
export async function fetchMastersGamePgn(id: string, token?: string): Promise<string> {
	const headers: Record<string, string> = {
		Accept: 'application/x-chess-pgn'
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(`https://explorer.lichess.ovh/masters/pgn/${encodeURIComponent(id)}`, {
		headers
	});
	if (res.status === 404) throw new Error(`Masters game "${id}" not found.`);
	if (res.status === 429) throw new Error('Rate limited by Lichess.');
	if (!res.ok) throw new Error(`Masters PGN: HTTP ${res.status}`);
	return await res.text();
}

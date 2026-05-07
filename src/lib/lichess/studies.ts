/**
 * Lichess Study API wrappers. Used by the repertoire sync page to link a
 * repertoire to a private (or public) Lichess study and push/pull updates.
 *
 * Endpoints covered:
 *   GET  /api/study/by/{username}     — NDJSON list of the user's studies.
 *                                       With OAuth, includes private studies
 *                                       the user owns or is a member of.
 *   GET  /api/study/{id}.pgn          — whole study as PGN (one game per
 *                                       chapter). Needs OAuth for private.
 *   POST /api/study/{id}/import-pgn   — form-encoded; imports PGN as new
 *                                       chapter(s). Needs study:write scope.
 *                                       Response is NDJSON; each line is a
 *                                       chapter created.
 *   DELETE /api/study/{id}/{chapter}  — remove a chapter. Needs study:write.
 *
 * Lichess's OAuth app isn't pre-registered by us (any URL works as client_id),
 * so all calls are plain `fetch` with an Authorization: Bearer header.
 */

const LICHESS = 'https://lichess.org';

export interface LichessStudyMeta {
	id: string;
	name: string;
	createdAt?: number;
	updatedAt?: number;
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		...extra
	};
}

/**
 * Parse an NDJSON stream into an array of T. Blank lines are skipped.
 * Non-JSON lines abort with an error so we don't silently eat garbage.
 */
async function parseNdjson<T>(res: Response): Promise<T[]> {
	const text = await res.text();
	const out: T[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		out.push(JSON.parse(trimmed) as T);
	}
	return out;
}

/**
 * List the user's studies (their own + member-of). With OAuth this returns
 * private studies too; without it, only public ones. `username` is the
 * Lichess handle of the current user — we read it off the stored OAuth token.
 */
export async function listMyStudies(token: string, username: string): Promise<LichessStudyMeta[]> {
	const res = await fetch(`${LICHESS}/api/study/by/${encodeURIComponent(username)}`, {
		headers: authHeaders(token, { Accept: 'application/x-ndjson' })
	});
	if (!res.ok) {
		throw new Error(`Couldn't list studies: HTTP ${res.status}`);
	}
	const rows = await parseNdjson<{
		id: string;
		name: string;
		createdAt?: number;
		updatedAt?: number;
	}>(res);
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt
	}));
}

export type StudyVisibility = 'public' | 'unlisted' | 'private';

export interface CreateStudyParams {
	name: string;
	visibility?: StudyVisibility;
}

/**
 * Create a new (empty) study and return its ID. Lichess caps new studies at
 * 30/day per account. The spec requires `name`, `visibility`, and five
 * permission fields (`computer`/`explorer`/`cloneable`/`shareable`/`chat`);
 * we hard-code sensible defaults for personal prep — engine + explorer for
 * the owner, chat/share owner-only, cloning off. Users can loosen those on
 * Lichess after the fact if they want to open it up.
 *
 * Lichess implicitly creates one empty chapter on study creation; after the
 * first push, that empty "Chapter 1" sits alongside the COBRA chapter. The
 * caller is expected to surface this to the user so they can delete it on
 * Lichess if they care.
 */
export async function createStudy(
	token: string,
	params: CreateStudyParams
): Promise<{ id: string }> {
	const body = new URLSearchParams({
		name: params.name,
		visibility: params.visibility ?? 'private',
		computer: 'owner',
		explorer: 'owner',
		cloneable: 'nobody',
		shareable: 'owner',
		chat: 'owner',
		sticky: 'true'
	});
	const res = await fetch(`${LICHESS}/api/study`, {
		method: 'POST',
		headers: authHeaders(token, {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json'
		}),
		body
	});
	if (res.status === 403) {
		throw new Error('No permission to create studies — reconnect Lichess with study:write.');
	}
	if (res.status === 429) {
		throw new Error('Lichess rate-limited new-study creation (max 30/day). Try again later.');
	}
	if (!res.ok) {
		const t = await res.text().catch(() => '');
		throw new Error(`Couldn't create study: HTTP ${res.status}${t ? ` — ${t.slice(0, 180)}` : ''}`);
	}
	const data = (await res.json()) as { id?: string };
	if (!data.id) throw new Error('Lichess accepted the request but returned no study ID.');
	return { id: data.id };
}

/**
 * Fetch a study as PGN. `variations: true` keeps all the branching we rely on
 * for repertoire parsing; `clocks: false` avoids clock-comment noise.
 */
export async function fetchStudyPgn(token: string, studyId: string): Promise<string> {
	const url = new URL(`${LICHESS}/api/study/${encodeURIComponent(studyId)}.pgn`);
	url.searchParams.set('clocks', 'false');
	url.searchParams.set('comments', 'true');
	url.searchParams.set('variations', 'true');
	const res = await fetch(url.toString(), {
		headers: authHeaders(token, { Accept: 'application/x-chess-pgn' })
	});
	if (res.status === 404) {
		throw new Error('Study not found — check the study ID (or the OAuth scope if it is private).');
	}
	if (!res.ok) {
		throw new Error(`Couldn't fetch study PGN: HTTP ${res.status}`);
	}
	return await res.text();
}

export interface ImportedChapter {
	id: string;
	name?: string;
}

/**
 * Import PGN into a study as a new chapter. Lichess may split the PGN into
 * multiple chapters if it contains multiple games; the response is NDJSON
 * with one chapter entry per created chapter. We return them all, but the
 * caller typically treats the first as "the" chapter for replace-on-push.
 */
export async function importPgnToStudy(
	token: string,
	studyId: string,
	pgn: string,
	chapterName: string,
	orientation: 'white' | 'black' = 'white'
): Promise<ImportedChapter[]> {
	const body = new URLSearchParams({
		name: chapterName,
		pgn,
		orientation,
		variant: 'standard',
		mode: 'normal'
	});
	const res = await fetch(`${LICHESS}/api/study/${encodeURIComponent(studyId)}/import-pgn`, {
		method: 'POST',
		headers: authHeaders(token, {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/x-ndjson'
		}),
		body
	});
	if (res.status === 403) {
		throw new Error('No permission to write to that study — reconnect Lichess with study:write.');
	}
	if (!res.ok) {
		const t = await res.text().catch(() => '');
		throw new Error(`PGN import failed: HTTP ${res.status}${t ? ` — ${t.slice(0, 180)}` : ''}`);
	}
	// Response shape varies — despite the `Accept: application/x-ndjson`
	// header we send, Lichess emits any of:
	//   - a single JSON object with `chapters: [...]` and `error: ...`
	//     (the shape it actually uses today for one-chapter imports)
	//   - a single JSON object with `chapter: {id, name}`
	//   - a single JSON object that's just `{id, name}`
	//   - NDJSON, one row per chapter
	// Capture the raw body up front so the empty-result path can surface
	// the actual payload — silently dropping it is what made the original
	// "wrong response shape" bug invisible.
	const rawBody = await res.text();
	const out = parseImportPgnResponse(rawBody);
	if (out.length === 0) {
		const snippet = rawBody.slice(0, 200).replace(/\s+/g, ' ').trim() || '(empty body)';
		throw new Error(`Lichess accepted the import but produced no chapter. Response: ${snippet}`);
	}
	return out;
}

interface ImportPgnRow {
	chapter?: { id?: unknown; name?: unknown };
	chapters?: Array<{ id?: unknown; name?: unknown }>;
	id?: unknown;
	name?: unknown;
	error?: unknown;
}

export function parseImportPgnResponse(body: string): ImportedChapter[] {
	const out: ImportedChapter[] = [];
	const consume = (raw: ImportPgnRow): void => {
		if (Array.isArray(raw.chapters)) {
			for (const c of raw.chapters) {
				if (c && typeof c === 'object' && typeof c.id === 'string') {
					out.push({ id: c.id, name: typeof c.name === 'string' ? c.name : undefined });
				}
			}
			return;
		}
		const c = raw.chapter ?? raw;
		if (c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string') {
			out.push({
				id: (c as { id: string }).id,
				name:
					typeof (c as { name?: unknown }).name === 'string'
						? (c as { name: string }).name
						: undefined
			});
		}
	};

	const trimmed = body.trim();
	// Whole-body JSON-object case (the shape Lichess emits today).
	if (trimmed.startsWith('{')) {
		try {
			const obj = JSON.parse(trimmed) as ImportPgnRow;
			consume(obj);
			if (out.length > 0) return out;
			// Body parsed but yielded no chapters. Surface a server-side
			// `error` string if present so callers don't see a generic
			// "no chapter" message when Lichess actually told us why.
			if (typeof obj.error === 'string' && obj.error.trim().length > 0) {
				throw new Error(`Lichess rejected the import: ${obj.error}`);
			}
		} catch (e) {
			if (e instanceof Error && e.message.startsWith('Lichess rejected')) throw e;
			// Otherwise fall through to NDJSON parse below.
		}
	}

	// NDJSON line-by-line fallback.
	for (const line of body.split('\n')) {
		const lineTrim = line.trim();
		if (!lineTrim) continue;
		try {
			consume(JSON.parse(lineTrim) as ImportPgnRow);
		} catch {
			/* skip non-JSON noise */
		}
	}
	return out;
}

export interface LichessChapterInfo {
	id: string;
	name: string;
	hasMoves: boolean;
}

/**
 * List a study's chapters by parsing its PGN export. Lichess's study PGN
 * sets each chapter's `[Site "https://lichess.org/study/{studyId}/{chapterId}"]`
 * header, which is the only public way to recover a chapter's ID — there's
 * no dedicated "list chapters" endpoint.
 *
 * Used right after `createStudy` to find and delete the auto-generated empty
 * "Chapter 1" so pushes end up with only the chapters we actually wanted.
 */
export async function listChapters(token: string, studyId: string): Promise<LichessChapterInfo[]> {
	const pgn = await fetchStudyPgn(token, studyId);
	// Lichess delimits chapters with blank lines. A minimal parse pulls the
	// Site header out of each chapter block; we avoid a full PGN parser here
	// because we only need two headers + a "does it have moves?" sniff.
	const blocks: string[] = [];
	let buf: string[] = [];
	for (const line of pgn.split('\n')) {
		if (line.trim() === '' && buf.length > 0 && buf[buf.length - 1].trim() === '') {
			blocks.push(buf.join('\n'));
			buf = [];
		} else {
			buf.push(line);
		}
	}
	if (buf.length > 0) blocks.push(buf.join('\n'));

	const out: LichessChapterInfo[] = [];
	const sitePattern =
		/\[Site\s+"https:\/\/lichess\.org\/study\/[a-zA-Z0-9]{8}\/([a-zA-Z0-9]{8})"\]/;
	const eventPattern = /\[Event\s+"([^"]*)"\]/;
	for (const block of blocks) {
		const site = sitePattern.exec(block);
		if (!site) continue;
		const event = eventPattern.exec(block);
		// A chapter "has moves" if any non-header, non-blank line after the
		// last header contains anything other than the result token. Crude but
		// reliable for the empty-chapter detection we need.
		const bodyLines = block
			.split('\n')
			.filter((l) => !l.startsWith('[') && l.trim() !== '' && l.trim() !== '*');
		const hasMoves = bodyLines.join(' ').trim().length > 0;
		out.push({ id: site[1], name: event?.[1] ?? '', hasMoves });
	}
	return out;
}

/**
 * Delete a chapter from a study. Used by push to replace rather than append.
 * Silently tolerates 404 — if the user deleted the chapter on Lichess in the
 * meantime, there's nothing for us to clean up.
 */
export async function deleteChapter(
	token: string,
	studyId: string,
	chapterId: string
): Promise<void> {
	const res = await fetch(
		`${LICHESS}/api/study/${encodeURIComponent(studyId)}/${encodeURIComponent(chapterId)}`,
		{
			method: 'DELETE',
			headers: authHeaders(token)
		}
	);
	if (res.status === 404) return;
	if (!res.ok) {
		throw new Error(`Couldn't delete old chapter: HTTP ${res.status}`);
	}
}

/**
 * Accept any of:
 *   - bare study ID ("abc12345")
 *   - full study URL ("https://lichess.org/study/abc12345")
 *   - chapter URL  ("https://lichess.org/study/abc12345/xyz09876")
 * and return the study ID. Returns null if no plausible 8-char ID is found.
 */
export function parseStudyIdInput(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	// A bare ID is 8 alphanumeric chars on Lichess.
	const bare = /^[a-zA-Z0-9]{8}$/.exec(trimmed);
	if (bare) return trimmed;
	const url = /\/study\/([a-zA-Z0-9]{8})/.exec(trimmed);
	if (url) return url[1];
	return null;
}

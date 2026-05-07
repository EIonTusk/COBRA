/**
 * Wraps an opaque sync blob inside a 1-position PGN so it can ride inside a
 * Lichess study chapter. Lichess's study API has no "edit chapter" endpoint —
 * the only way to put data into a study is `import-pgn`, which requires real
 * PGN. We exploit the fact that PGN move comments (`{ ... }`) accept arbitrary
 * text and that the parser preserves custom headers we tag with a `Cobra*`
 * prefix.
 *
 * The chapter is intentionally a no-op game (one ply, draw result) so it's
 * not visible noise inside a Lichess study viewer — it shows up as an empty
 * chapter with a header but nothing to "play through". The sync identity
 * (kind, repId, revision, deviceId, pushedAt, schema) lives in the headers
 * so we can read it back without first decompressing the body, which lets us
 * do cheap revision checks before pulling and decoding.
 *
 * Format (ASCII, exactly):
 *
 *     [Event "COBRA-SYNC:rep:9f8a"]
 *     [Site "https://cobra.chess/sync"]
 *     [Result "*"]
 *     [CobraKind "rep"]
 *     [CobraRepId "9f8a..."]      // omitted for kind="global"
 *     [CobraRevision "42"]
 *     [CobraDeviceId "uuid"]
 *     [CobraPushedAt "1741..."]
 *     [CobraSchema "1"]
 *     [CobraBlobLen "12345"]      // length of the base64 payload, for sanity
 *
 *     { cobra-sync-v1:H4sIAA... } *
 *
 * The blank line between headers and movetext is required by the PGN spec.
 * The sentinel prefix `cobra-sync-v1:` lets the parser distinguish our
 * payloads from any other comment Lichess might inject.
 */

export type SyncKind = 'rep' | 'global';

export interface BlobMeta {
	kind: SyncKind;
	/** Required when `kind === 'rep'`. */
	repId?: string;
	revision: number;
	deviceId: string;
	pushedAt: number;
	/** Schema version for the wire format itself, not the payload bundle. */
	schema?: number;
}

export interface ParsedBlob extends BlobMeta {
	blob: string;
}

export const PGN_BLOB_PREFIX = 'cobra-sync-v1:';
export const SYNC_EVENT_PREFIX = 'COBRA-SYNC';
const CURRENT_SCHEMA = 1;

export function chapterNameForRep(repId: string): string {
	// Use the first 8 chars of the rep UUID for a stable, terse chapter
	// label. The full ID lives in the CobraRepId header so collisions across
	// reps with similar prefixes are still resolvable.
	return `${SYNC_EVENT_PREFIX}:rep:${repId.slice(0, 8)}`;
}

export function chapterNameForGlobal(): string {
	return `${SYNC_EVENT_PREFIX}:global`;
}

export function isSyncChapterName(name: string | undefined | null): boolean {
	if (!name) return false;
	return name.startsWith(`${SYNC_EVENT_PREFIX}:`);
}

export function wrapBlobAsPgn(blob: string, meta: BlobMeta): string {
	if (meta.kind === 'rep' && !meta.repId) {
		throw new Error('wrapBlobAsPgn: kind="rep" requires repId');
	}
	const event =
		meta.kind === 'rep' ? chapterNameForRep(meta.repId as string) : chapterNameForGlobal();
	const headers: string[] = [
		`[Event "${escapeHeader(event)}"]`,
		`[Site "https://cobra.chess/sync"]`,
		`[Result "*"]`,
		`[CobraKind "${meta.kind}"]`
	];
	if (meta.kind === 'rep' && meta.repId) {
		headers.push(`[CobraRepId "${escapeHeader(meta.repId)}"]`);
	}
	headers.push(`[CobraRevision "${meta.revision}"]`);
	headers.push(`[CobraDeviceId "${escapeHeader(meta.deviceId)}"]`);
	headers.push(`[CobraPushedAt "${meta.pushedAt}"]`);
	headers.push(`[CobraSchema "${meta.schema ?? CURRENT_SCHEMA}"]`);
	headers.push(`[CobraBlobLen "${blob.length}"]`);

	// PGN body: a single comment carrying the payload, then a result token.
	// We keep this on one line so studies render it as an empty chapter.
	const body = `{ ${PGN_BLOB_PREFIX}${blob} } *`;
	return `${headers.join('\n')}\n\n${body}\n`;
}

/**
 * Extract the headers + payload from a single-game PGN we previously wrote
 * with `wrapBlobAsPgn`. Whitespace inside the brace comment is tolerated —
 * Lichess's study export normalises some whitespace, and we don't want to
 * be fragile to it.
 *
 * Returns null if the PGN doesn't carry the sentinel prefix or any required
 * header is missing.
 */
export function parseBlobFromPgn(pgn: string): ParsedBlob | null {
	const headers = parseHeaders(pgn);
	const kindRaw = headers.get('CobraKind');
	if (kindRaw !== 'rep' && kindRaw !== 'global') return null;
	const revisionRaw = headers.get('CobraRevision');
	const deviceId = headers.get('CobraDeviceId');
	const pushedAtRaw = headers.get('CobraPushedAt');
	if (!revisionRaw || !deviceId || !pushedAtRaw) return null;
	const revision = Number.parseInt(revisionRaw, 10);
	const pushedAt = Number.parseInt(pushedAtRaw, 10);
	if (!Number.isFinite(revision) || !Number.isFinite(pushedAt)) return null;
	const repId = kindRaw === 'rep' ? (headers.get('CobraRepId') ?? undefined) : undefined;
	if (kindRaw === 'rep' && !repId) return null;

	const blob = extractBlobFromBody(pgn);
	if (!blob) return null;

	const schemaRaw = headers.get('CobraSchema');
	const schema = schemaRaw ? Number.parseInt(schemaRaw, 10) : CURRENT_SCHEMA;

	return {
		kind: kindRaw,
		repId,
		revision,
		deviceId,
		pushedAt,
		schema: Number.isFinite(schema) ? schema : CURRENT_SCHEMA,
		blob
	};
}

/**
 * Lightweight read of just the headers, without bothering to grab the
 * payload. Used by the conflict-check path: refetch the chapter, peek the
 * revision, decide whether the push is safe — no need to decode the blob.
 */
export function parseMetaFromPgn(pgn: string): BlobMeta | null {
	const parsed = parseBlobFromPgn(pgn);
	if (!parsed) return null;
	const { blob: _blob, ...meta } = parsed;
	return meta;
}

// --- Header helpers --------------------------------------------------------

function parseHeaders(pgn: string): Map<string, string> {
	const out = new Map<string, string>();
	// PGN headers: [Tag "Value"] one per line, until a blank line. We tolerate
	// CR/LF and surrounding whitespace.
	const lines = pgn.split(/\r?\n/);
	const headerPattern = /^\s*\[\s*([A-Za-z][A-Za-z0-9_]*)\s+"((?:\\.|[^"\\])*)"\s*\]\s*$/;
	for (const line of lines) {
		if (line.trim() === '') {
			// Blank line ends the header block. But Lichess sometimes
			// inserts a header block followed by movetext on the same
			// line — keep going if we haven't seen any header yet.
			if (out.size > 0) break;
			continue;
		}
		const m = headerPattern.exec(line);
		if (!m) continue;
		out.set(m[1], unescapeHeader(m[2]));
	}
	return out;
}

function extractBlobFromBody(pgn: string): string | null {
	const idx = pgn.indexOf(PGN_BLOB_PREFIX);
	if (idx === -1) return null;
	// The blob runs from after the prefix up to the next `}`. Lichess could
	// in principle insert whitespace inside the comment, so we strip
	// whitespace from the captured slice.
	const close = pgn.indexOf('}', idx);
	if (close === -1) return null;
	const raw = pgn.slice(idx + PGN_BLOB_PREFIX.length, close);
	return raw.replace(/\s+/g, '');
}

function escapeHeader(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescapeHeader(value: string): string {
	return value.replace(/\\(.)/g, '$1');
}

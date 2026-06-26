/**
 * Wraps an opaque sync blob inside a 1-position PGN so it can ride inside a
 * Lichess study chapter. Lichess's study API has no "edit chapter" endpoint —
 * the only way to put data into a study is `import-pgn`, which requires real
 * PGN. We exploit the fact that PGN move comments (`{ ... }`) accept arbitrary
 * text and that the parser preserves them.
 *
 * The chapter is intentionally a no-op game (one ply, draw result) so it's
 * not visible noise inside a Lichess study viewer — it shows up as an empty
 * chapter with a header but nothing to "play through".
 *
 * Wire format (v2 — current emit format):
 *
 *     [Event "COBRA-SYNC:rep:9f8a"]   <-- preserved by Lichess; cleanup key
 *     [Site "https://cobra.chess/sync"]
 *     [Date "????.??.??"]
 *     [Round "?"]
 *     [White "COBRA"]
 *     [Black "Sync"]
 *     [Result "*"]
 *     [CobraKind "rep"]               <-- emitted for forward-compat, but
 *     [CobraRepId "9f8a..."]              Lichess silently strips all
 *     [CobraRevision "42"]                non-STR headers on export, so
 *     [CobraDeviceId "uuid"]              parsing never relies on them
 *     [CobraPushedAt "1741..."]
 *     [CobraSchema "2"]
 *
 *     1. e4 { cobra-sync-v2:<meta-base64>.<blob-base64> } *
 *
 * The blank line between headers and movetext is required by the PGN spec.
 * The Seven Tag Roster (Event/Site/Date/Round/White/Black/Result) is the
 * minimum strict PGN parsers accept; Lichess's `import-pgn` endpoint
 * silently produces zero chapters for blob-only PGNs that omit them.
 *
 * The body carries one dummy move (`1. e4`) so Lichess sees an actual
 * game, not just an empty position with a comment — the latter chapterizes
 * to nothing on Lichess's side. The sentinel prefix `cobra-sync-v2:` lets
 * the parser distinguish our payloads, and `<meta>.<blob>` packs the sync
 * identity (kind/repId/revision/deviceId/pushedAt) into the comment so it
 * survives Lichess's header-stripping. Base64url has no `.`, so the
 * separator is unambiguous.
 *
 * Legacy v1 format `{ cobra-sync-v1:<blob> }` is still readable — meta
 * fields come from headers when Lichess preserved them, otherwise the
 * chapter is only resolvable by chapter name (Event header) and cleanup
 * by name still removes it on the next push.
 */

export type SyncKind = 'rep' | 'rep-core' | 'rep-telemetry' | 'global';

/**
 * True for any repertoire-scoped kind — i.e. one that carries a `repId`.
 * `'rep'` is the pre-split combined scope; `'rep-core'`/`'rep-telemetry'`
 * are the tier-split scopes (issue #68). Only `'global'` is rep-less.
 */
export function isRepScopeKind(kind: SyncKind): boolean {
	return kind === 'rep' || kind === 'rep-core' || kind === 'rep-telemetry';
}

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

export const PGN_BLOB_PREFIX_V1 = 'cobra-sync-v1:';
export const PGN_BLOB_PREFIX_V2 = 'cobra-sync-v2:';
/** Kept as the v1 alias for callers outside this module. New code reads/writes via the helpers below. */
export const PGN_BLOB_PREFIX = PGN_BLOB_PREFIX_V1;
export const SYNC_EVENT_PREFIX = 'COBRA-SYNC';
const CURRENT_SCHEMA = 2;

export function chapterNameForRep(repId: string): string {
	// Use the first 8 chars of the rep UUID for a stable, terse chapter
	// label. The full ID lives in the CobraRepId header so collisions across
	// reps with similar prefixes are still resolvable.
	return `${SYNC_EVENT_PREFIX}:rep:${repId.slice(0, 8)}`;
}

export function chapterNameForGlobal(): string {
	return `${SYNC_EVENT_PREFIX}:global`;
}

/**
 * Scope/chapter name for any kind.
 *
 * `rep-core` deliberately REUSES the legacy `COBRA-SYNC:rep:<id8>` name so a
 * core push overwrites a pre-split combined chapter in place (the import
 * cleanup sweeps same-named chapters) — that's the combined→tier migration,
 * for free. `rep-telemetry` gets its own `COBRA-SYNC:rep-telemetry:<id8>`
 * name. The kind is disambiguated by the in-comment meta, not the name.
 */
export function chapterNameForKind(kind: SyncKind, repId?: string): string {
	if (kind === 'global') return chapterNameForGlobal();
	if (!repId) throw new Error(`chapterNameForKind: kind="${kind}" requires repId`);
	if (kind === 'rep-telemetry') return `${SYNC_EVENT_PREFIX}:rep-telemetry:${repId.slice(0, 8)}`;
	// 'rep' (legacy combined) and 'rep-core' share the `:rep:` name.
	return `${SYNC_EVENT_PREFIX}:rep:${repId.slice(0, 8)}`;
}

export function isSyncChapterName(name: string | undefined | null): boolean {
	if (!name) return false;
	return name.startsWith(`${SYNC_EVENT_PREFIX}:`);
}

export function wrapBlobAsPgn(blob: string, meta: BlobMeta): string {
	if (isRepScopeKind(meta.kind) && !meta.repId) {
		throw new Error(`wrapBlobAsPgn: kind="${meta.kind}" requires repId`);
	}
	const event = chapterNameForKind(meta.kind, meta.repId);
	const headers: string[] = [
		`[Event "${escapeHeader(event)}"]`,
		`[Site "https://cobra.chess/sync"]`,
		`[Date "????.??.??"]`,
		`[Round "?"]`,
		`[White "COBRA"]`,
		`[Black "Sync"]`,
		`[Result "*"]`,
		`[CobraKind "${meta.kind}"]`
	];
	if (isRepScopeKind(meta.kind) && meta.repId) {
		headers.push(`[CobraRepId "${escapeHeader(meta.repId)}"]`);
	}
	headers.push(`[CobraRevision "${meta.revision}"]`);
	headers.push(`[CobraDeviceId "${escapeHeader(meta.deviceId)}"]`);
	headers.push(`[CobraPushedAt "${meta.pushedAt}"]`);
	headers.push(`[CobraSchema "${meta.schema ?? CURRENT_SCHEMA}"]`);
	headers.push(`[CobraBlobLen "${blob.length}"]`);

	// PGN body: one dummy move + the meta+blob payload as a post-move
	// comment, then a result token. The dummy move is what makes Lichess
	// actually create a chapter — `import-pgn` silently returns no
	// chapters for blob-only PGNs that don't have any movetext. The meta
	// rides inside the comment as a base64url prefix separated from the
	// blob by `.` (a character base64url never produces), because Lichess
	// strips non-STR headers on PGN export — keeping the headers around
	// is forward-compat noise, the comment is the actual source of truth.
	const metaWire = encodeMetaWire(meta);
	const body = `1. e4 { ${PGN_BLOB_PREFIX_V2}${metaWire}.${blob} } *`;
	return `${headers.join('\n')}\n\n${body}\n`;
}

function encodeMetaWire(meta: BlobMeta): string {
	// Minified JSON with short field names to keep the prefix terse; the
	// blob dominates byte count regardless, but a tighter meta also keeps
	// the chapter under Lichess's per-chapter size limit by a few bytes.
	const payload: Record<string, unknown> = {
		k: meta.kind,
		r: meta.revision,
		d: meta.deviceId,
		p: meta.pushedAt,
		s: meta.schema ?? CURRENT_SCHEMA
	};
	if (isRepScopeKind(meta.kind) && meta.repId) payload.i = meta.repId;
	const json = JSON.stringify(payload);
	return btoaUrl(new TextEncoder().encode(json));
}

function decodeMetaWire(encoded: string): BlobMeta | null {
	try {
		const bytes = atobUrl(encoded);
		const json = new TextDecoder().decode(bytes);
		const obj = JSON.parse(json) as Record<string, unknown>;
		const kind = obj.k;
		if (kind !== 'rep' && kind !== 'rep-core' && kind !== 'rep-telemetry' && kind !== 'global') {
			return null;
		}
		const revision = typeof obj.r === 'number' ? obj.r : Number.parseInt(String(obj.r), 10);
		const pushedAt = typeof obj.p === 'number' ? obj.p : Number.parseInt(String(obj.p), 10);
		const deviceId = typeof obj.d === 'string' ? obj.d : '';
		if (!Number.isFinite(revision) || !Number.isFinite(pushedAt) || !deviceId) return null;
		const repId = kind !== 'global' && typeof obj.i === 'string' ? obj.i : undefined;
		if (kind !== 'global' && !repId) return null;
		const schemaRaw = obj.s;
		const schema =
			typeof schemaRaw === 'number'
				? schemaRaw
				: Number.parseInt(String(schemaRaw ?? CURRENT_SCHEMA), 10);
		return {
			kind,
			repId,
			revision,
			deviceId,
			pushedAt,
			schema: Number.isFinite(schema) ? schema : CURRENT_SCHEMA
		};
	} catch {
		return null;
	}
}

function btoaUrl(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function atobUrl(s: string): Uint8Array {
	const pad = '='.repeat((4 - (s.length % 4)) % 4);
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Extract the meta + payload from a single-game PGN we previously wrote
 * with `wrapBlobAsPgn`. Whitespace inside the brace comment is tolerated —
 * Lichess's study export normalises some whitespace, and we don't want to
 * be fragile to it.
 *
 * Resolution order for the meta fields:
 *   1. v2 in-comment meta (`cobra-sync-v2:<meta>.<blob>`) — survives Lichess
 *      stripping non-STR headers, so this is the canonical source.
 *   2. Cobra* PGN headers — fallback when Lichess preserved them (some
 *      versions did, modern exports don't). Only consulted for v1-prefixed
 *      payloads, which never carried in-comment meta.
 * Returns null if neither source resolves the required fields.
 */
export function parseBlobFromPgn(pgn: string): ParsedBlob | null {
	const extracted = extractBlobFromBody(pgn);
	if (!extracted) return null;
	const { blob, prefixVersion, metaWire } = extracted;

	if (prefixVersion === 2 && metaWire) {
		const meta = decodeMetaWire(metaWire);
		if (meta) return { ...meta, blob };
		// metaWire was present but didn't decode — fall through to the
		// header path before giving up. Allows partial recovery if a future
		// schema bump corrupts the inner JSON.
	}

	const headers = parseHeaders(pgn);
	const kindRaw = headers.get('CobraKind');
	if (
		kindRaw !== 'rep' &&
		kindRaw !== 'rep-core' &&
		kindRaw !== 'rep-telemetry' &&
		kindRaw !== 'global'
	) {
		return null;
	}
	const revisionRaw = headers.get('CobraRevision');
	const deviceId = headers.get('CobraDeviceId');
	const pushedAtRaw = headers.get('CobraPushedAt');
	if (!revisionRaw || !deviceId || !pushedAtRaw) return null;
	const revision = Number.parseInt(revisionRaw, 10);
	const pushedAt = Number.parseInt(pushedAtRaw, 10);
	if (!Number.isFinite(revision) || !Number.isFinite(pushedAt)) return null;
	const repId = kindRaw !== 'global' ? (headers.get('CobraRepId') ?? undefined) : undefined;
	if (kindRaw !== 'global' && !repId) return null;

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
 * Lightweight read of just the meta fields, without keeping the (potentially
 * huge) blob string around. Used by the conflict-check path: refetch the
 * chapter, peek the revision, decide whether the push is safe.
 */
export function parseMetaFromPgn(pgn: string): BlobMeta | null {
	const parsed = parseBlobFromPgn(pgn);
	if (!parsed) return null;
	const { blob: _blob, ...meta } = parsed;
	return meta;
}

/**
 * Parse the chapter's `[Event "..."]` header. Used by sync chapter
 * identification: the chapter name is the only metadata Lichess
 * reliably preserves across import/export, so it's the cleanup key.
 */
export function parseEventFromPgn(pgn: string): string | null {
	const headers = parseHeaders(pgn);
	return headers.get('Event') ?? null;
}

/**
 * Extract just the base64 blob string from a chapter block, without
 * insisting on the meta resolving. Used as the legacy fallback path
 * for pull: when both the v2 in-comment meta AND the v1 Cobra* headers
 * have been stripped by Lichess, the encoded bundle is the only thing
 * left and the caller can still decode it to recover `kind`+`repId`.
 *
 * Returns the blob string only; meta resolution is the caller's problem.
 */
export function extractRawBlobString(pgn: string): string | null {
	const extracted = extractBlobFromBody(pgn);
	return extracted ? extracted.blob : null;
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

interface ExtractedBody {
	blob: string;
	prefixVersion: 1 | 2;
	/** Present only for v2. The base64url-encoded meta JSON. */
	metaWire?: string;
}

function extractBlobFromBody(pgn: string): ExtractedBody | null {
	// Prefer v2 when present; fall back to v1 for chapters wrapped by older
	// code. Both prefixes use the same `cobra-sync-` stem so a single search
	// for the stem is the cheapest discriminator.
	const stemIdx = pgn.indexOf('cobra-sync-v');
	if (stemIdx === -1) return null;
	const close = pgn.indexOf('}', stemIdx);
	if (close === -1) return null;
	// Identify which prefix matched. The two prefixes only differ in the
	// version digit, so we sniff one byte after the `v`.
	const v2 = pgn.startsWith(PGN_BLOB_PREFIX_V2, stemIdx);
	const v1 = pgn.startsWith(PGN_BLOB_PREFIX_V1, stemIdx);
	if (!v2 && !v1) return null;
	const prefix = v2 ? PGN_BLOB_PREFIX_V2 : PGN_BLOB_PREFIX_V1;
	const raw = pgn.slice(stemIdx + prefix.length, close).replace(/\s+/g, '');
	if (v2) {
		// `<meta-base64>.<blob-base64>`. Base64url never produces `.`, so a
		// missing dot means the chapter was emitted by code that wrote the
		// v2 prefix but no meta payload — treat as blob-only and fall back
		// to header-driven meta.
		const dot = raw.indexOf('.');
		if (dot === -1) return { blob: raw, prefixVersion: 2 };
		return {
			blob: raw.slice(dot + 1),
			prefixVersion: 2,
			metaWire: raw.slice(0, dot)
		};
	}
	return { blob: raw, prefixVersion: 1 };
}

function escapeHeader(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescapeHeader(value: string): string {
	return value.replace(/\\(.)/g, '$1');
}

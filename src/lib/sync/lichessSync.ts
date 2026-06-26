/**
 * Sync-flavoured Lichess-study operations.
 *
 * The plain studies.ts wrappers are tuned for the existing repertoire <-> study
 * publish/pull flow (PGN that's actually a chess tree). Sync uses the same
 * endpoints but treats chapters as opaque, named blob slots:
 *   - one chapter per repertoire (Event "COBRA-SYNC:rep:<idprefix>")
 *   - one global chapter (Event "COBRA-SYNC:global")
 *
 * Lichess offers no atomic "edit chapter" call, so updates are import-then-
 * delete: import the new chapter (giving it a fresh ID), then delete the old
 * one. Doing it in that order means a failed push leaves the old chapter
 * intact rather than a deleted-but-not-replaced gap. Brief duplicate is
 * harmless — pull picks the higher revision.
 *
 * Cleanup matches old chapters by `[Event]` name (not by parsed Cobra* meta)
 * because Lichess strips non-STR PGN headers on export. The chapter name
 * survives because we pass it as the import-pgn `name` param.
 *
 * Chapter IDs come from the `[ChapterURL]` header Lichess injects on
 * export — NOT from `[Site]`, which round-trips back as whatever we
 * imported (we send `https://cobra.chess/sync`, so that's what comes
 * back, study-wide).
 *
 * Conflict gate: before pushing, refetch the existing chapter via `pullBlob`
 * which resolves the revision from (1) the v2 in-comment payload, (2) the
 * Cobra* headers if Lichess preserved them, or (3) a bundle decode for
 * legacy header-stripped chapters (revision=0 in that case, so the push
 * goes through and the legacy chapter is replaced). If remote's revision
 * is higher than the caller's `expectedPriorRevision`, throw a
 * `SyncConflictError` instead of pushing — the store turns that into a
 * user-facing prompt.
 */

import {
	createStudy,
	deleteChapter,
	fetchStudyPgn,
	importPgnToStudy,
	listChapters,
	listMyStudies
} from '$lib/lichess/studies';
import {
	SYNC_EVENT_PREFIX,
	chapterNameForGlobal,
	chapterNameForRep,
	extractRawBlobString,
	isSyncChapterName,
	parseBlobFromPgn,
	parseEventFromPgn,
	parseMetaFromPgn,
	wrapBlobAsPgn,
	type BlobMeta,
	type ParsedBlob,
	type SyncKind
} from './pgnWrap';
import { decodeBundle, type AnyBundle } from './bundle';

const SYNC_STUDY_NAME = 'COBRA Sync';

export class SyncConflictError extends Error {
	readonly localRevision: number;
	readonly remoteRevision: number;
	readonly remoteDeviceId: string;
	readonly remotePushedAt: number;
	readonly kind: SyncKind;
	readonly repId?: string;
	constructor(args: {
		localRevision: number;
		remoteRevision: number;
		remoteDeviceId: string;
		remotePushedAt: number;
		kind: SyncKind;
		repId?: string;
	}) {
		super(
			`Sync conflict: remote revision ${args.remoteRevision} is ahead of local ${args.localRevision}`
		);
		this.name = 'SyncConflictError';
		this.localRevision = args.localRevision;
		this.remoteRevision = args.remoteRevision;
		this.remoteDeviceId = args.remoteDeviceId;
		this.remotePushedAt = args.remotePushedAt;
		this.kind = args.kind;
		this.repId = args.repId;
	}
}

export interface SyncChapterRef {
	chapterId: string;
	/**
	 * The chapter's `[Event "..."]` header — the only metadata Lichess
	 * reliably preserves across the import/export round-trip. Used as
	 * the cleanup key when a push replaces a chapter.
	 */
	name: string;
	kind: SyncKind;
	/**
	 * Full rep UUID. May be undefined for legacy chapters whose meta lived
	 * only in the now-stripped `[CobraRepId]` header — those still match
	 * by name (the chapter's prefix carries the first 8 chars of the UUID).
	 */
	repId?: string;
	/** Defaults to 0 when meta isn't recoverable (legacy header-stripped chapter). */
	revision: number;
	/** Defaults to '' when meta isn't recoverable. */
	deviceId: string;
	/** Defaults to 0 when meta isn't recoverable. */
	pushedAt: number;
}

export interface FoundOrCreatedStudy {
	studyId: string;
	created: boolean;
}

/**
 * Locate the user's `COBRA Sync` study, or make a fresh one. Returns the
 * (potentially newly created) study ID. Caller is expected to persist it
 * to settings.sync.studyId so subsequent runs skip the lookup.
 *
 * If a `preferStudyId` is provided we trust it without re-listing — the
 * common case after first-run setup.
 */
export async function findOrCreateSyncStudy(
	token: string,
	username: string,
	preferStudyId?: string
): Promise<FoundOrCreatedStudy> {
	if (preferStudyId) {
		// Fast path: try to read it. If it 404s we'll fall through to the
		// listing path — covers the case where the user deleted the study
		// on Lichess and the next sync re-creates it.
		try {
			await fetchStudyPgn(token, preferStudyId);
			return { studyId: preferStudyId, created: false };
		} catch {
			/* fall through */
		}
	}
	const all = await listMyStudies(token, username);
	const existing = all.find((s) => s.name === SYNC_STUDY_NAME);
	if (existing) return { studyId: existing.id, created: false };

	const { id } = await createStudy(token, { name: SYNC_STUDY_NAME, visibility: 'private' });
	// Lichess auto-creates an empty "Chapter 1" with the study. Delete it so
	// the study only carries our COBRA-SYNC chapters.
	try {
		const chapters = await listChapters(token, id);
		const empty = chapters.find((c) => !isSyncChapterName(c.name) && !c.hasMoves);
		if (empty) await deleteChapter(token, id, empty.id);
	} catch {
		/* best-effort: empty chapter is harmless if we can't remove it */
	}
	return { studyId: id, created: true };
}

/**
 * List the COBRA-SYNC chapters in the study, with parsed metadata. Built by
 * fetching the whole study PGN (the only listing endpoint Lichess exposes)
 * and matching chapter blocks by `[Event "COBRA-SYNC:..."]`.
 */
export async function listSyncChapters(token: string, studyId: string): Promise<SyncChapterRef[]> {
	const { syncChapters } = await inspectStudy(token, studyId);
	return syncChapters;
}

/**
 * Single-fetch read of a study: returns both the COBRA-SYNC chapters
 * (parsed) *and* the total chapter count (sync + non-sync). Counting
 * the total lets the caller flag a near-cap warning before Lichess's
 * 64-chapter hard limit actually fires; doing it in one fetch avoids
 * a second round-trip from `listSyncChapters` when the caller wants
 * both pieces (push cleanup, "near cap" probe).
 */
export async function inspectStudy(
	token: string,
	studyId: string
): Promise<{ syncChapters: SyncChapterRef[]; totalChapters: number }> {
	const pgn = await fetchStudyPgn(token, studyId);
	const blocks = splitPgnBlocks(pgn);
	const syncChapters: SyncChapterRef[] = [];
	let totalChapters = 0;
	for (const block of blocks) {
		const siteMatch =
			/\[ChapterURL\s+"https:\/\/lichess\.org\/study\/[a-zA-Z0-9]{8}\/([a-zA-Z0-9]{8})"\]/.exec(
				block
			);
		if (!siteMatch) continue;
		totalChapters += 1;
		const eventName = parseEventFromPgn(block);
		if (!eventName || !isSyncChapterName(eventName)) continue;

		// Identify kind from the chapter name — Lichess preserves [Event]
		// because we passed it as the import-pgn `name` param. Metadata
		// in custom Cobra* headers may have been stripped on export, so
		// `parseMetaFromPgn` is best-effort; the chapter is still
		// classifiable as a sync chapter by its name alone.
		const kind: SyncKind | null = nameToKind(eventName);
		if (!kind) continue;
		const meta = parseMetaFromPgn(block);
		syncChapters.push({
			chapterId: siteMatch[1],
			name: eventName,
			kind,
			repId: meta?.repId,
			revision: meta?.revision ?? 0,
			deviceId: meta?.deviceId ?? '',
			pushedAt: meta?.pushedAt ?? 0
		});
	}
	return { syncChapters, totalChapters };
}

/** Map a sync chapter's `[Event]` name back to its kind discriminator. */
function nameToKind(name: string): SyncKind | null {
	if (name === `${SYNC_EVENT_PREFIX}:global`) return 'global';
	if (name.startsWith(`${SYNC_EVENT_PREFIX}:rep:`)) return 'rep';
	return null;
}

/**
 * Pull the parsed blob for a single chapter (rep or global). Returns null
 * if no matching chapter exists.
 *
 * Three resolution paths, in order of preference:
 *   1. Full meta from v2 in-comment payload (`cobra-sync-v2:<meta>.<blob>`).
 *   2. Meta from Cobra* PGN headers (when Lichess preserved them).
 *   3. Legacy fallback: just the raw blob string, with kind/repId recovered
 *      by decoding the bundle. revision/deviceId/pushedAt become 0/''/0 so
 *      callers know meta wasn't recoverable — conflict detection treats
 *      this as "no known prior revision" and the push goes through, which
 *      is the right behaviour for legacy chapters about to be replaced.
 */
export async function pullBlob(
	token: string,
	studyId: string,
	kind: SyncKind,
	repId: string | undefined
): Promise<ParsedBlob | null> {
	const pgn = await fetchStudyPgn(token, studyId);
	let legacyCandidate: { blob: string; bundle: AnyBundle } | null = null;
	for (const block of splitPgnBlocks(pgn)) {
		const parsed = parseBlobFromPgn(block);
		if (parsed) {
			if (parsed.kind !== kind) continue;
			if (kind === 'rep' && parsed.repId !== repId) continue;
			return parsed;
		}
		// parseBlobFromPgn failed — could be a non-sync chapter, or a sync
		// chapter whose meta got stripped by Lichess on export. Check the
		// chapter name first to filter out the former, then decode the
		// bundle to recover kind/repId.
		const eventName = parseEventFromPgn(block);
		if (!eventName || !isSyncChapterName(eventName)) continue;
		const blobStr = extractRawBlobString(block);
		if (!blobStr) continue;
		let bundle: AnyBundle;
		try {
			bundle = await decodeBundle(blobStr);
		} catch {
			continue;
		}
		if (bundle.kind !== kind) continue;
		if (kind === 'rep' && (bundle as { repertoireId?: string }).repertoireId !== repId) continue;
		// Prefer an exact match, but keep the first legacy candidate as a
		// backstop — the loop continues so a later block with full meta can
		// still win.
		if (!legacyCandidate) legacyCandidate = { blob: blobStr, bundle };
	}
	if (legacyCandidate) {
		const { blob, bundle } = legacyCandidate;
		// `bundle.kind === kind` was guaranteed by the filter above; use the
		// narrowed `kind` so the wider AnyBundle union (which now includes the
		// tier scopes) doesn't leak past this legacy header-stripped path.
		const recoveredRepId =
			kind === 'rep' ? (bundle as { repertoireId?: string }).repertoireId : undefined;
		return {
			kind,
			repId: recoveredRepId,
			revision: 0,
			deviceId: '',
			pushedAt: 0,
			blob
		};
	}
	return null;
}

/**
 * One-shot pull of every sync chapter in the study. Walks the study PGN once
 * (instead of N+1 fetches in `pullAll` × `pullBlob`) and yields a parsed blob
 * for each `COBRA-SYNC:*` chapter — falling back to bundle-decode when the
 * v2/header meta has been stripped.
 *
 * Returns each parsed blob plus the originating chapter ID, so the caller
 * can deduplicate by `[Event]` name (highest revision wins) without a
 * second fetch.
 */
export async function pullAllBlobs(
	token: string,
	studyId: string
): Promise<Array<ParsedBlob & { chapterId: string; chapterName: string }>> {
	const pgn = await fetchStudyPgn(token, studyId);
	const out: Array<ParsedBlob & { chapterId: string; chapterName: string }> = [];
	for (const block of splitPgnBlocks(pgn)) {
		const siteMatch =
			/\[ChapterURL\s+"https:\/\/lichess\.org\/study\/[a-zA-Z0-9]{8}\/([a-zA-Z0-9]{8})"\]/.exec(
				block
			);
		if (!siteMatch) continue;
		const chapterId = siteMatch[1];
		const eventName = parseEventFromPgn(block);
		if (!eventName || !isSyncChapterName(eventName)) continue;

		const parsed = parseBlobFromPgn(block);
		if (parsed) {
			out.push({ ...parsed, chapterId, chapterName: eventName });
			continue;
		}
		// Header-stripped legacy chapter. Recover via bundle decode.
		const blobStr = extractRawBlobString(block);
		if (!blobStr) continue;
		let bundle: AnyBundle;
		try {
			bundle = await decodeBundle(blobStr);
		} catch {
			continue;
		}
		// Legacy header-stripped recovery only resolves the pre-split scopes;
		// tier scopes (rep-core/rep-telemetry) always carry v2 in-comment meta
		// and never fall through to here.
		if (bundle.kind !== 'rep' && bundle.kind !== 'global') continue;
		const kind: SyncKind = bundle.kind;
		const repId = kind === 'rep' ? (bundle as { repertoireId?: string }).repertoireId : undefined;
		out.push({
			kind,
			repId,
			revision: 0,
			deviceId: '',
			pushedAt: 0,
			blob: blobStr,
			chapterId,
			chapterName: eventName
		});
	}
	return out;
}

export interface PushResult {
	chapterId: string;
	revision: number;
	deviceId: string;
	pushedAt: number;
	/**
	 * Total chapters in the study (sync + non-sync) right after this push,
	 * read from the cleanup pass's existing `inspectStudy` call. Used by the
	 * caller to surface a near-cap warning before Lichess's 64-chapter hard
	 * limit fires. Undefined when the cleanup pass failed (the push itself
	 * still succeeded — count just wasn't observed).
	 */
	totalChapters?: number;
}

/**
 * Push a fresh chapter for `kind/repId`, atomically replacing whatever was
 * there before by import-then-delete. The returned revision is `meta.revision`.
 *
 * `expectedPriorRevision` is the revision the caller last saw (or `null` if
 * they've never pushed/pulled this kind). If the remote's current revision is
 * greater, we throw `SyncConflictError` without writing.
 */
export async function pushBlob(
	token: string,
	studyId: string,
	blob: string,
	meta: BlobMeta,
	expectedPriorRevision: number | null
): Promise<PushResult> {
	// Conflict check: refetch + compare revisions before mutating.
	const existing = await pullBlob(token, studyId, meta.kind, meta.repId);
	if (existing) {
		const expected = expectedPriorRevision ?? -1;
		if (existing.revision > expected) {
			throw new SyncConflictError({
				localRevision: expected,
				remoteRevision: existing.revision,
				remoteDeviceId: existing.deviceId,
				remotePushedAt: existing.pushedAt,
				kind: meta.kind,
				repId: meta.repId
			});
		}
	}

	const pgn = wrapBlobAsPgn(blob, meta);
	const chapterName =
		meta.kind === 'rep' ? chapterNameForRep(meta.repId as string) : chapterNameForGlobal();
	// One-line size diagnostic so a "PGN too large" rejection surfaces
	// which chapter and how big it was without the user having to dig.
	console.log(`[sync] pushing ${chapterName}: blob=${blob.length} pgn=${pgn.length} bytes`);
	let created;
	try {
		created = await importPgnToStudy(token, studyId, pgn, chapterName);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (/too large/i.test(msg)) {
			throw new Error(
				`Sync chapter ${chapterName} is too large for Lichess (${pgn.length} bytes). ` +
					'Try clearing scan history (mistakes / WDL data) for this repertoire on this device.',
				{ cause: e }
			);
		}
		throw e;
	}
	if (created.length === 0) {
		throw new Error('Lichess accepted the import but returned no chapter ID.');
	}
	const newChapterId = created[0].id;

	// Sweep older COBRA-SYNC chapters that share the chapter NAME (Event
	// header) with the one we just imported. We match by name rather than
	// by parsed kind/repId because Lichess strips non-STR PGN headers on
	// export — pre-v2 chapters lose their CobraKind/CobraRepId fields and
	// can't be classified that way, but their `[Event]` survives because
	// it came from the import-pgn `name` param. Matching by name also
	// cleans up duplicates that piled up under the old (header-driven)
	// cleanup before this fix.
	let totalChapters: number | undefined;
	try {
		const inspected = await inspectStudy(token, studyId);
		totalChapters = inspected.totalChapters;
		for (const c of inspected.syncChapters) {
			if (c.chapterId === newChapterId) continue;
			if (c.name !== chapterName) continue;
			await deleteChapter(token, studyId, c.chapterId);
			if (typeof totalChapters === 'number') totalChapters -= 1;
		}
	} catch {
		/* best-effort cleanup; the new chapter is the canonical one */
	}

	return {
		chapterId: newChapterId,
		revision: meta.revision,
		deviceId: meta.deviceId,
		pushedAt: meta.pushedAt,
		totalChapters
	};
}

/**
 * Delete the sync chapter(s) for a single repertoire. Called when a rep is
 * deleted locally so its blob stops resurrecting on other devices' pulls and
 * stops accumulating as a duplicate. Matches by `[Event]` name — the only
 * metadata Lichess reliably preserves — so it also sweeps any stale duplicate
 * chapters that share the rep's name. Returns the count removed.
 */
export async function deleteRepChapters(
	token: string,
	studyId: string,
	repId: string
): Promise<number> {
	const target = chapterNameForRep(repId);
	const chapters = await listSyncChapters(token, studyId);
	let removed = 0;
	for (const c of chapters) {
		if (c.name !== target) continue;
		try {
			await deleteChapter(token, studyId, c.chapterId);
			removed += 1;
		} catch {
			/* best-effort: a lingering chapter is caught by the pull-side guard */
		}
	}
	return removed;
}

/**
 * Delete every COBRA-SYNC chapter in the study. Used by the "Disconnect &
 * forget" flow when the user wants to clean up Lichess-side too.
 */
export async function purgeSyncChapters(token: string, studyId: string): Promise<number> {
	const chapters = await listSyncChapters(token, studyId);
	let removed = 0;
	for (const c of chapters) {
		try {
			await deleteChapter(token, studyId, c.chapterId);
			removed += 1;
		} catch {
			/* keep going */
		}
	}
	return removed;
}

// --- Helpers ---------------------------------------------------------------

/**
 * Split a study's full PGN export into its chapter-level blocks. Lichess
 * separates chapters with one or more blank lines after the movetext.
 */
function splitPgnBlocks(pgn: string): string[] {
	// Each chapter starts with a `[Event ...]` header, so we split on the
	// boundary "blank line followed by `[Event`". This is tolerant of
	// chapters that themselves contain blank lines inside the movetext.
	const lines = pgn.split(/\r?\n/);
	const blocks: string[] = [];
	let buf: string[] = [];
	let inBlock = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*\[Event\s+"/.test(line)) {
			if (inBlock && buf.length > 0) blocks.push(buf.join('\n'));
			buf = [line];
			inBlock = true;
			continue;
		}
		if (inBlock) buf.push(line);
	}
	if (inBlock && buf.length > 0) blocks.push(buf.join('\n'));
	return blocks;
}

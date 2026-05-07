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
 * Conflict gate: before pushing, refetch the existing chapter and read its
 * CobraRevision header. If remote's revision is higher than the caller's
 * `expectedPriorRevision`, throw a `SyncConflictError` instead of pushing.
 * The store turns that into a user-facing prompt.
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
	chapterNameForGlobal,
	chapterNameForRep,
	isSyncChapterName,
	parseBlobFromPgn,
	parseMetaFromPgn,
	wrapBlobAsPgn,
	type BlobMeta,
	type ParsedBlob,
	type SyncKind
} from './pgnWrap';

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
	kind: SyncKind;
	repId?: string;
	revision: number;
	deviceId: string;
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
			/\[Site\s+"https:\/\/lichess\.org\/study\/[a-zA-Z0-9]{8}\/([a-zA-Z0-9]{8})"\]/.exec(block);
		if (!siteMatch) continue;
		totalChapters += 1;
		const meta = parseMetaFromPgn(block);
		if (!meta) continue;
		syncChapters.push({
			chapterId: siteMatch[1],
			kind: meta.kind,
			repId: meta.repId,
			revision: meta.revision,
			deviceId: meta.deviceId,
			pushedAt: meta.pushedAt
		});
	}
	return { syncChapters, totalChapters };
}

/**
 * Pull the parsed blob for a single chapter (rep or global). Returns null
 * if the chapter doesn't exist.
 */
export async function pullBlob(
	token: string,
	studyId: string,
	kind: SyncKind,
	repId: string | undefined
): Promise<ParsedBlob | null> {
	const pgn = await fetchStudyPgn(token, studyId);
	for (const block of splitPgnBlocks(pgn)) {
		const parsed = parseBlobFromPgn(block);
		if (!parsed) continue;
		if (parsed.kind !== kind) continue;
		if (kind === 'rep' && parsed.repId !== repId) continue;
		return parsed;
	}
	return null;
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
	const created = await importPgnToStudy(token, studyId, pgn, chapterName);
	if (created.length === 0) {
		throw new Error('Lichess accepted the import but returned no chapter ID.');
	}
	const newChapterId = created[0].id;

	// Sweep older COBRA-SYNC chapters with the same kind/repId, except the
	// one we just imported. If the user has somehow accumulated duplicates
	// (a previous push that got interrupted between import and delete) we
	// clean them all up here. Same fetch also gives us the total chapter
	// count so the caller can warn the user about the 64-chapter cap.
	let totalChapters: number | undefined;
	try {
		const inspected = await inspectStudy(token, studyId);
		totalChapters = inspected.totalChapters;
		for (const c of inspected.syncChapters) {
			if (c.chapterId === newChapterId) continue;
			if (c.kind !== meta.kind) continue;
			if (meta.kind === 'rep' && c.repId !== meta.repId) continue;
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

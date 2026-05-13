import { describe, expect, it } from 'vitest';
import {
	chapterNameForGlobal,
	chapterNameForRep,
	extractRawBlobString,
	isSyncChapterName,
	parseBlobFromPgn,
	parseEventFromPgn,
	parseMetaFromPgn,
	wrapBlobAsPgn,
	type BlobMeta
} from './pgnWrap';

const REP_META: BlobMeta = {
	kind: 'rep',
	repId: '9f8a1234-aaaa-bbbb-cccc-deadbeefbeef',
	revision: 7,
	deviceId: 'device-uuid-1',
	pushedAt: 1_741_000_000_000
};

const GLOBAL_META: BlobMeta = {
	kind: 'global',
	revision: 3,
	deviceId: 'device-uuid-2',
	pushedAt: 1_741_500_000_000
};

describe('pgnWrap', () => {
	it('round-trips a rep blob through wrap → parse', () => {
		const blob = 'H4sIAAAAAAAA_3MzMjMzAAJTAwAuKsXJBQAAAA';
		const pgn = wrapBlobAsPgn(blob, REP_META);
		const parsed = parseBlobFromPgn(pgn);
		expect(parsed).not.toBeNull();
		expect(parsed?.kind).toBe('rep');
		expect(parsed?.repId).toBe(REP_META.repId);
		expect(parsed?.revision).toBe(7);
		expect(parsed?.deviceId).toBe('device-uuid-1');
		expect(parsed?.pushedAt).toBe(1_741_000_000_000);
		expect(parsed?.blob).toBe(blob);
	});

	it('round-trips a global blob', () => {
		const blob = 'somethingbase64urlish_-AAA';
		const pgn = wrapBlobAsPgn(blob, GLOBAL_META);
		const parsed = parseBlobFromPgn(pgn);
		expect(parsed?.kind).toBe('global');
		expect(parsed?.repId).toBeUndefined();
		expect(parsed?.revision).toBe(3);
		expect(parsed?.blob).toBe(blob);
	});

	it('parseMetaFromPgn returns headers without the blob', () => {
		const blob = 'AAAA';
		const pgn = wrapBlobAsPgn(blob, REP_META);
		const meta = parseMetaFromPgn(pgn);
		expect(meta).not.toBeNull();
		expect(meta?.revision).toBe(7);
		expect((meta as { blob?: string }).blob).toBeUndefined();
	});

	it('tolerates whitespace mangling inside the comment', () => {
		const blob = 'H4sIAA';
		const pgn = wrapBlobAsPgn(blob, REP_META);
		// Simulate Lichess inserting a newline inside the comment.
		const mangled = pgn.replace(blob, blob.slice(0, 3) + '\n   ' + blob.slice(3));
		const parsed = parseBlobFromPgn(mangled);
		expect(parsed?.blob).toBe(blob);
	});

	it('returns null for non-COBRA PGNs', () => {
		const pgn = `[Event "FIDE World Championship"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n`;
		expect(parseBlobFromPgn(pgn)).toBeNull();
	});

	it('returns null when revision is missing', () => {
		const pgn = `[Event "COBRA-SYNC:rep:abc"]\n[CobraKind "rep"]\n[CobraRepId "abc"]\n[CobraDeviceId "d"]\n[CobraPushedAt "1"]\n\n{ cobra-sync-v1:AAA } *\n`;
		expect(parseBlobFromPgn(pgn)).toBeNull();
	});

	it('parses meta from the v2 in-comment payload even when Cobra* headers are stripped', () => {
		const blob = 'H4sIAA';
		const pgn = wrapBlobAsPgn(blob, REP_META);
		// Simulate Lichess's export: strip every Cobra* header. The chapter
		// `[Event]` survives because we passed it as the import-pgn `name`
		// param; only the non-STR custom headers go.
		const stripped = pgn
			.split('\n')
			.filter((l) => !/^\[Cobra/.test(l))
			.join('\n');
		const parsed = parseBlobFromPgn(stripped);
		expect(parsed?.kind).toBe('rep');
		expect(parsed?.repId).toBe(REP_META.repId);
		expect(parsed?.revision).toBe(7);
		expect(parsed?.deviceId).toBe('device-uuid-1');
		expect(parsed?.pushedAt).toBe(1_741_000_000_000);
		expect(parsed?.blob).toBe(blob);
	});

	it('parses a global blob from in-comment meta when headers are stripped', () => {
		const blob = 'BBBBcc-_AAA';
		const pgn = wrapBlobAsPgn(blob, GLOBAL_META);
		const stripped = pgn
			.split('\n')
			.filter((l) => !/^\[Cobra/.test(l))
			.join('\n');
		const parsed = parseBlobFromPgn(stripped);
		expect(parsed?.kind).toBe('global');
		expect(parsed?.repId).toBeUndefined();
		expect(parsed?.revision).toBe(3);
		expect(parsed?.blob).toBe(blob);
	});

	it('reads back a legacy v1 blob whose meta lives in headers', () => {
		// The v1 format never carried in-comment meta — only Cobra* headers.
		// If those headers survive Lichess's export, the legacy chapter is
		// still readable.
		const blob = 'OldBlobAAA';
		const pgn = `[Event "COBRA-SYNC:rep:9f8a"]\n[Site "https://cobra.chess/sync"]\n[Date "????.??.??"]\n[Round "?"]\n[White "COBRA"]\n[Black "Sync"]\n[Result "*"]\n[CobraKind "rep"]\n[CobraRepId "9f8a1234-aaaa-bbbb-cccc-deadbeefbeef"]\n[CobraRevision "4"]\n[CobraDeviceId "old-device"]\n[CobraPushedAt "1740000000000"]\n\n1. e4 { cobra-sync-v1:${blob} } *\n`;
		const parsed = parseBlobFromPgn(pgn);
		expect(parsed?.kind).toBe('rep');
		expect(parsed?.revision).toBe(4);
		expect(parsed?.blob).toBe(blob);
	});

	it('extractRawBlobString returns the blob even when meta is unrecoverable', () => {
		// Worst case: v1 chapter with stripped Cobra* headers. Meta gone,
		// but the gzipped bundle is still in the comment. The caller can
		// recover kind/repId by decoding the bundle.
		const pgn = `[Event "COBRA-SYNC:rep:9f8a"]\n[Site "https://lichess.org/study/abcdefgh/aaaaaaaa"]\n[Date "????.??.??"]\n[Round "?"]\n[White "COBRA"]\n[Black "Sync"]\n[Result "*"]\n\n1. e4 { cobra-sync-v1:H4sIRecoverable } *\n`;
		expect(parseBlobFromPgn(pgn)).toBeNull();
		expect(extractRawBlobString(pgn)).toBe('H4sIRecoverable');
	});

	it('parseEventFromPgn returns the chapter name', () => {
		const pgn = wrapBlobAsPgn('AAA', REP_META);
		expect(parseEventFromPgn(pgn)).toBe('COBRA-SYNC:rep:9f8a1234');
	});

	it('chapter names follow the documented prefix', () => {
		expect(chapterNameForRep(REP_META.repId as string)).toBe('COBRA-SYNC:rep:9f8a1234');
		expect(chapterNameForGlobal()).toBe('COBRA-SYNC:global');
		expect(isSyncChapterName('COBRA-SYNC:rep:abc')).toBe(true);
		expect(isSyncChapterName('Some other chapter')).toBe(false);
		expect(isSyncChapterName(undefined)).toBe(false);
	});

	it('rejects rep meta without a repId at wrap time', () => {
		expect(() =>
			wrapBlobAsPgn('AAA', { kind: 'rep', revision: 1, deviceId: 'd', pushedAt: 0 })
		).toThrow();
	});
});

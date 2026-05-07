import { describe, expect, it } from 'vitest';
import {
	chapterNameForGlobal,
	chapterNameForRep,
	isSyncChapterName,
	parseBlobFromPgn,
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

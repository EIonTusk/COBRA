import { describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';

import { encodeShare, decodeShare, type ShareBundle } from './share';
import { STARTPOS_FEN, STARTPOS_KEY } from '$lib/chess/fen';

function minimalBundle(): ShareBundle {
	const now = 1_700_000_000_000;
	return {
		version: 1,
		repertoire: {
			id: 'rep-1',
			name: 'Italian as White',
			color: 'white',
			rootFen: STARTPOS_FEN,
			rootFenKey: STARTPOS_KEY,
			createdAt: now,
			updatedAt: now,
			coverageSnapshot: null
		},
		nodes: [
			{
				repertoireId: 'rep-1',
				fenKey: STARTPOS_KEY,
				children: [
					{
						san: 'e4',
						uci: 'e2e4',
						toFenKey: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
					}
				]
			}
		],
		cards: [
			{
				repertoireId: 'rep-1',
				fenKey: STARTPOS_KEY,
				expectedSan: 'e4',
				fsrs: createEmptyCard(new Date(now)),
				dueAt: now
			}
		],
		ideaCards: []
	};
}

describe('share codec roundtrip', () => {
	it('encode → decode returns structurally equal bundle', async () => {
		const bundle = minimalBundle();
		const encoded = await encodeShare(bundle);
		expect(typeof encoded).toBe('string');
		// base64url: no '+' '/' or '=' padding.
		expect(encoded).not.toMatch(/[+/=]/);
		const decoded = await decodeShare(encoded);
		// ts-fsrs Card contains Date instances which round-trip as ISO strings
		// through JSON. Compare via JSON-normalised form to avoid Date-vs-string
		// mismatch on the fsrs sub-object.
		expect(JSON.parse(JSON.stringify(decoded))).toEqual(JSON.parse(JSON.stringify(bundle)));
	});

	it('decode rejects unsupported versions', async () => {
		const bundle = minimalBundle();
		// Hand-forge an encoded payload with version 99.
		const forged = { ...bundle, version: 99 } as unknown as ShareBundle;
		const encoded = await encodeShare(forged);
		await expect(decodeShare(encoded)).rejects.toThrow(/Unsupported share version/);
	});

	it('decode rejects malformed base64url', async () => {
		await expect(decodeShare('!!!not-a-real-payload!!!')).rejects.toBeTruthy();
	});

	it('compresses meaningfully compared to raw JSON', async () => {
		// Build a bundle with enough redundancy that gzip wins. Previously the
		// assertion compared against raw JSON length, but for a tiny bundle
		// gzip's header overhead can exceed the savings. Inflate the node list
		// so the test actually measures compression, not framing overhead.
		const bundle = minimalBundle();
		for (let i = 0; i < 100; i++) {
			bundle.nodes.push({
				repertoireId: 'rep-1',
				fenKey: `fake-key-${i} w KQkq -`,
				children: [{ san: 'e4', uci: 'e2e4', toFenKey: `fake-next-${i} b KQkq -` }]
			});
		}
		const raw = JSON.stringify(bundle);
		const encoded = await encodeShare(bundle);
		expect(encoded.length).toBeLessThan(raw.length);
	});
});

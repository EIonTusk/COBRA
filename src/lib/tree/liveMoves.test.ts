import { describe, expect, it } from 'vitest';
import type { RepertoireNode } from '$lib/types';
import { answerSan, liveMoves, liveMovesAnswerFirst } from './liveMoves';

function node(...moves: Array<[string, boolean?]>): RepertoireNode {
	return {
		repertoireId: 'r',
		fenKey: 'P',
		children: moves.map(([san, disabled]) => ({
			san,
			uci: 'xxxx',
			toFenKey: san,
			...(disabled ? { disabled } : {})
		}))
	};
}

describe('liveMoves', () => {
	it('drops disabled moves', () => {
		expect(liveMoves(node(['Bc5', true], ['Nf6'])).map((e) => e.san)).toEqual(['Nf6']);
		expect(liveMoves(undefined)).toEqual([]);
	});
});

describe('answerSan (issue #102)', () => {
	it("keeps the card's own move while it is live", () => {
		expect(answerSan(node(['Nf6'], ['Bc5']), 'Bc5')).toBe('Bc5');
	});

	it('falls back to a live alternative when the card move is disabled', () => {
		expect(answerSan(node(['Bc5', true], ['Nf6']), 'Bc5')).toBe('Nf6');
	});

	it('has no answer when every prepared move is disabled', () => {
		expect(answerSan(node(['Bc5', true], ['Nf6', true]), 'Bc5')).toBeNull();
	});

	it('keeps the card move at a position with no saved moves', () => {
		expect(answerSan(node(), 'Bc5')).toBe('Bc5');
		expect(answerSan(undefined, 'Bc5')).toBe('Bc5');
	});

	it('orders the answer first among live moves', () => {
		const n = node(['Nf6'], ['Bc5', true], ['d6']);
		expect(liveMovesAnswerFirst(n, 'd6').map((e) => e.san)).toEqual(['d6', 'Nf6']);
		expect(liveMovesAnswerFirst(n, 'Bc5').map((e) => e.san)).toEqual(['Nf6', 'd6']);
	});
});

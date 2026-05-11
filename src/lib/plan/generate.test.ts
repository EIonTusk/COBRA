import { describe, it, expect } from 'vitest';

import { generatePlanCardContent } from './generate';
import type { SerializedMiddlegameAggregate } from '$lib/types';

function emptyAggregate(): SerializedMiddlegameAggregate {
	return {
		totalLines: 0,
		pliesWindow: 12,
		topNextMoves: [],
		pawnMoves: [],
		pieceJourneys: [],
		castling: { white: { short: 0, long: 0 }, black: { short: 0, long: 0 } },
		attackSquares: []
	};
}

describe('generatePlanCardContent', () => {
	it('returns a no-data answer when the aggregate is empty', () => {
		const out = generatePlanCardContent({
			aggregate: emptyAggregate(),
			planForColor: 'white'
		});
		expect(out.prompt).toMatch(/White/);
		expect(out.answer).toMatch(/No master-game data/);
	});

	it('includes opening name in the prompt when provided', () => {
		const out = generatePlanCardContent({
			aggregate: emptyAggregate(),
			planForColor: 'black',
			openingName: 'Sicilian Defense: Najdorf'
		});
		expect(out.prompt).toContain('Black');
		expect(out.prompt).toContain('Sicilian Defense: Najdorf');
	});

	it('lists pawn moves for the requested colour only', () => {
		const agg: SerializedMiddlegameAggregate = {
			...emptyAggregate(),
			totalLines: 10,
			pawnMoves: [
				{ color: 'white', san: 'c4', from: 'c2', to: 'c4', isCapture: false, count: 6 },
				{ color: 'white', san: 'a3', from: 'a2', to: 'a3', isCapture: false, count: 1 },
				{ color: 'black', san: 'b5', from: 'b7', to: 'b5', isCapture: false, count: 8 }
			]
		};
		const out = generatePlanCardContent({ aggregate: agg, planForColor: 'white' });
		expect(out.answer).toContain('c4');
		// Black's pawn moves shouldn't appear when planForColor is white.
		expect(out.answer).not.toContain('b5');
		// Sub-threshold a3 should be filtered out (1/10 = 10% < 18%).
		expect(out.answer).not.toContain('a3');
	});

	it('drops piece journeys that stayed on their starting square', () => {
		const agg: SerializedMiddlegameAggregate = {
			...emptyAggregate(),
			totalLines: 10,
			pieceJourneys: [
				{ color: 'white', role: 'knight', from: 'g1', to: 'f3', count: 5 },
				{ color: 'white', role: 'bishop', from: 'c1', to: 'c1', count: 8 }
			]
		};
		const out = generatePlanCardContent({ aggregate: agg, planForColor: 'white' });
		expect(out.answer).toContain('Ng1 → f3');
		expect(out.answer).not.toContain('Bc1 → c1');
	});

	it('restricts key squares to the opponent half', () => {
		const agg: SerializedMiddlegameAggregate = {
			...emptyAggregate(),
			totalLines: 10,
			attackSquares: [
				{ square: 'e5', attacker: 'white', count: 8, captureCount: 1 },
				{ square: 'e2', attacker: 'white', count: 9, captureCount: 0 }
			]
		};
		const out = generatePlanCardContent({ aggregate: agg, planForColor: 'white' });
		// White attacking from rank 5 (opponent half) is in-plan.
		expect(out.answer).toContain('e5');
		// e2 is in White's own half — not a "press" square.
		expect(out.answer).not.toContain('e2');
	});

	it('emits castling tendency when meaningful', () => {
		const agg: SerializedMiddlegameAggregate = {
			...emptyAggregate(),
			totalLines: 10,
			castling: {
				white: { short: 7, long: 1 },
				black: { short: 0, long: 0 }
			}
		};
		const out = generatePlanCardContent({ aggregate: agg, planForColor: 'white' });
		expect(out.answer).toContain('O-O');
		expect(out.answer).toContain('7/10');
	});
});

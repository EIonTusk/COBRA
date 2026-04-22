import { describe, expect, it } from 'vitest';

import {
	wilsonInterval,
	rateStat,
	bootstrapMeanCI,
	normalMeanCI,
	zScore,
	percentileFromZ,
	intervalsOverlap,
	betaBinomialPosterior,
	shrinkageMean,
	cohensD,
	normalCdf,
	formatInterval,
	formatZ
} from './stats';

describe('wilsonInterval', () => {
	it('returns zero-width at n=0', () => {
		expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 0 });
	});

	it('handles k=0 without NaN (edge of Normal approximation)', () => {
		const ci = wilsonInterval(0, 20);
		expect(ci.lo).toBe(0);
		expect(ci.hi).toBeGreaterThan(0);
		expect(ci.hi).toBeLessThan(0.2);
	});

	it('handles k=n without producing >1 bound', () => {
		const ci = wilsonInterval(20, 20);
		expect(ci.hi).toBe(1);
		expect(ci.lo).toBeGreaterThan(0.8);
	});

	it('tightens as n grows', () => {
		const narrow = wilsonInterval(100, 1000);
		const wide = wilsonInterval(1, 10);
		expect(narrow.hi - narrow.lo).toBeLessThan(wide.hi - wide.lo);
	});

	it('centres near k/n for balanced samples', () => {
		const ci = wilsonInterval(50, 100);
		expect((ci.lo + ci.hi) / 2).toBeCloseTo(0.5, 2);
	});
});

describe('rateStat', () => {
	it('packs count/n/rate/ci', () => {
		const s = rateStat(3, 10);
		expect(s.count).toBe(3);
		expect(s.n).toBe(10);
		expect(s.rate).toBe(0.3);
		expect(s.ci95.lo).toBeGreaterThan(0);
		expect(s.ci95.hi).toBeLessThan(1);
	});
});

describe('bootstrapMeanCI', () => {
	it('returns zero-width at n=0', () => {
		expect(bootstrapMeanCI([])).toEqual({ lo: 0, hi: 0 });
	});

	it('returns a point interval at n=1', () => {
		expect(bootstrapMeanCI([42])).toEqual({ lo: 42, hi: 42 });
	});

	it('brackets the mean for moderate samples', () => {
		const samples = Array.from({ length: 200 }, (_, i) => i);
		const ci = bootstrapMeanCI(samples);
		const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
		expect(ci.lo).toBeLessThan(mean);
		expect(ci.hi).toBeGreaterThan(mean);
	});

	it('is deterministic given identical input', () => {
		const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		const a = bootstrapMeanCI(samples);
		const b = bootstrapMeanCI(samples);
		expect(a).toEqual(b);
	});
});

describe('normalMeanCI', () => {
	it('handles empty / single input', () => {
		expect(normalMeanCI([])).toEqual({ lo: 0, hi: 0 });
		expect(normalMeanCI([7])).toEqual({ lo: 7, hi: 7 });
	});

	it('brackets the mean for a known sample', () => {
		const samples = Array.from({ length: 100 }, (_, i) => i + 1);
		const ci = normalMeanCI(samples);
		expect(ci.lo).toBeLessThan(50.5);
		expect(ci.hi).toBeGreaterThan(50.5);
	});
});

describe('normalCdf', () => {
	it('is 0.5 at zero', () => {
		expect(normalCdf(0)).toBeCloseTo(0.5, 4);
	});

	it('matches known tail probabilities', () => {
		expect(normalCdf(1)).toBeCloseTo(0.8413, 3);
		expect(normalCdf(-1)).toBeCloseTo(0.1587, 3);
		expect(normalCdf(2)).toBeCloseTo(0.9772, 3);
	});
});

describe('zScore', () => {
	it('returns zero with percentile 50 when SD is 0', () => {
		const z = zScore(1, 1, 0);
		expect(z.z).toBe(0);
		expect(z.percentile).toBe(50);
	});

	it('is +1 when user is one SD above peer', () => {
		const z = zScore(110, 100, 10);
		expect(z.z).toBeCloseTo(1, 5);
		expect(z.percentile).toBeGreaterThan(80);
	});

	it('is negative below peer mean', () => {
		const z = zScore(90, 100, 10);
		expect(z.z).toBeCloseTo(-1, 5);
		expect(z.percentile).toBeLessThan(20);
	});
});

describe('percentileFromZ', () => {
	it('is 50 at z=0', () => {
		expect(percentileFromZ(0)).toBeCloseTo(50, 1);
	});

	it('clamps to [0, 100]', () => {
		expect(percentileFromZ(100)).toBeLessThanOrEqual(100);
		expect(percentileFromZ(-100)).toBeGreaterThanOrEqual(0);
	});
});

describe('intervalsOverlap', () => {
	it('returns true for touching intervals', () => {
		expect(intervalsOverlap({ lo: 0, hi: 1 }, { lo: 1, hi: 2 })).toBe(true);
	});

	it('returns false for disjoint intervals', () => {
		expect(intervalsOverlap({ lo: 0, hi: 1 }, { lo: 2, hi: 3 })).toBe(false);
	});

	it('returns true for contained intervals', () => {
		expect(intervalsOverlap({ lo: 0, hi: 10 }, { lo: 3, hi: 4 })).toBe(true);
	});
});

describe('betaBinomialPosterior', () => {
	it('returns prior mean when n=0', () => {
		const p = betaBinomialPosterior(0, 0, 0.3, 20);
		expect(p.mean).toBeCloseTo(0.3, 2);
	});

	it('pulls user estimate toward prior at small n', () => {
		const p = betaBinomialPosterior(2, 2, 0.3, 20); // user 100%, prior 30%
		expect(p.mean).toBeLessThan(0.6);
		expect(p.mean).toBeGreaterThan(0.3);
	});

	it('converges to user estimate at large n', () => {
		const p = betaBinomialPosterior(800, 1000, 0.3, 20);
		expect(p.mean).toBeCloseTo(0.8, 1);
	});

	it('produces an 80% CI that brackets the mean', () => {
		const p = betaBinomialPosterior(50, 100, 0.3, 20);
		expect(p.ci.lo).toBeLessThan(p.mean);
		expect(p.ci.hi).toBeGreaterThan(p.mean);
		expect(p.ci.lo).toBeGreaterThanOrEqual(0);
		expect(p.ci.hi).toBeLessThanOrEqual(1);
	});
});

describe('shrinkageMean', () => {
	it('leaves a grand-mean-only bucket at the grand mean', () => {
		const out = shrinkageMean([{ mean: 999, n: 0 }], 0.5);
		expect(out[0]).toBe(0.5);
	});

	it('partially shrinks a small-sample bucket', () => {
		const out = shrinkageMean([{ mean: 1.0, n: 5 }], 0.5, 20);
		expect(out[0]).toBeLessThan(1.0);
		expect(out[0]).toBeGreaterThan(0.5);
	});

	it('barely shrinks a large-sample bucket', () => {
		const out = shrinkageMean([{ mean: 1.0, n: 1000 }], 0.5, 20);
		expect(out[0]).toBeGreaterThan(0.98);
		expect(out[0]).toBeLessThanOrEqual(1.0);
	});
});

describe('cohensD', () => {
	it('returns 0 when sds are zero', () => {
		const d = cohensD({ mean: 1, sd: 0, n: 10 }, { mean: 2, sd: 0, n: 10 });
		expect(d).toBe(0);
	});

	it('is roughly 1 when means differ by one pooled SD', () => {
		const d = cohensD({ mean: 10, sd: 2, n: 100 }, { mean: 8, sd: 2, n: 100 });
		expect(d).toBeCloseTo(1, 1);
	});
});

describe('format helpers', () => {
	it('formats intervals as percentages', () => {
		const s = formatInterval({ lo: 0.123, hi: 0.456 }, 1, true);
		expect(s).toBe('[12.3%–45.6%]');
	});

	it('formats z-scores with sigma symbol', () => {
		expect(formatZ(1.5)).toBe('+1.50σ');
		expect(formatZ(-0.8)).toBe('−0.80σ');
	});
});

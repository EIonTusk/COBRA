/**
 * Statistical foundations for the Dossier.
 *
 * Every rate-based finding in the report is a sample proportion; every
 * mean-based finding (CP loss, WP loss) is a sample mean. Raw point
 * estimates without uncertainty — "blunder rate 4.2%" or "+14 cp worse
 * than peers" — tend to overstate the confidence of the data, especially
 * on sliced subsets (per-family, per-phase, per-clock-bucket). This
 * module ships the primitives every consumer needs to report honest
 * numbers:
 *
 *   - Wilson score interval for binomial proportions (handles small n
 *     gracefully, unlike the Normal approximation).
 *   - Bootstrap percentile intervals for non-binomial means (CP loss).
 *   - Z-score + percentile against a peer mean/SD.
 *   - Beta-Binomial posterior shrinkage using a peer prior, returning a
 *     credible interval that degrades gracefully when the user's slice is
 *     thin — e.g. 3 opposite-colour-bishop endings.
 *   - Empirical-Bayes shrinkage for per-bucket means against a grand
 *     mean (used by progression to suppress noise in low-volume months).
 *
 * No chess-specific semantics live here — everything is numeric. Tests
 * cover the behaviour around degenerate inputs (n=0, all-one outcomes,
 * user equal to peer).
 */

/** Two-sided interval. `lo <= point <= hi` where all three share units. */
export interface Interval {
	lo: number;
	hi: number;
}

/** A sample proportion with its Wilson 95% CI. */
export interface RateCI {
	count: number;
	n: number;
	rate: number;
	ci95: Interval;
}

/** Z-score of a user statistic against a peer mean/SD reference. */
export interface ZScore {
	user: number;
	peer: number;
	sd: number;
	z: number;
	/** Approximate percentile in 0..100 — P(peer < user) under Normal. */
	percentile: number;
}

/** Bayesian shrinkage result from a Beta(α, β) prior updated with (k, n). */
export interface PosteriorRate {
	/** Posterior mean. */
	mean: number;
	/** 80% equal-tailed credible interval by default; configurable. */
	ci: Interval;
	/** Effective sample size = prior weight + user sample. */
	effectiveN: number;
	/** Prior mean (peer) stored for display / auditing. */
	priorMean: number;
	/** Prior weight = α + β. */
	priorWeight: number;
}

const Z_95 = 1.959963984540054;

/** Standard Normal PDF. */
function phi(x: number): number {
	return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard Normal CDF via Abramowitz-Stegun 26.2.17. Accurate to ~7.5e-8.
 * Used for percentile estimation; not on any hot path.
 */
export function normalCdf(x: number): number {
	const sign = x < 0 ? -1 : 1;
	const ax = Math.abs(x);
	const t = 1 / (1 + 0.2316419 * ax);
	const y =
		1 -
		phi(ax) *
			(0.31938153 * t +
				-0.356563782 * t * t +
				1.781477937 * t * t * t +
				-1.821255978 * t * t * t * t +
				1.330274429 * t * t * t * t * t);
	return 0.5 * (1 + sign * (2 * y - 1));
}

/**
 * Wilson score interval for a binomial proportion. Handles k=0 and k=n
 * cleanly, unlike the Normal approximation which produces bounds outside
 * [0, 1] in those corners. Returns a zero-width interval at [0, 0] when
 * n = 0 so callers don't have to special-case.
 */
export function wilsonInterval(k: number, n: number, z = Z_95): Interval {
	if (n <= 0) return { lo: 0, hi: 0 };
	const kk = Math.max(0, Math.min(k, n));
	const p = kk / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const centre = (p + z2 / (2 * n)) / denom;
	const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
	return { lo: Math.max(0, centre - margin), hi: Math.min(1, centre + margin) };
}

/** Convenience: build a full {count, n, rate, ci95} tuple. */
export function rateStat(count: number, n: number): RateCI {
	const rate = n > 0 ? count / n : 0;
	return { count, n, rate, ci95: wilsonInterval(count, n) };
}

/**
 * Deterministic LCG. We want repeatable bootstrap CIs across re-scans of
 * the same data — a fresh random seed every call would jitter the UI for
 * no reason. Seed is the sample length XOR'd with a constant.
 */
function lcg(seed: number): () => number {
	let state = (seed ^ 0x9e3779b9) >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

/**
 * Bootstrap percentile interval for the mean of a sample. Uses `resamples`
 * resamples (default 1000) and returns the 2.5 / 97.5 percentiles. Seed is
 * derived from the sample so repeated calls on the same input agree.
 *
 * Degenerate cases:
 *   - sample length 0 → {lo: 0, hi: 0}
 *   - sample length 1 → {lo: x, hi: x}
 */
export function bootstrapMeanCI(
	samples: number[],
	{ resamples = 1000, z = Z_95 }: { resamples?: number; z?: number } = {}
): Interval {
	const n = samples.length;
	if (n === 0) return { lo: 0, hi: 0 };
	if (n === 1) return { lo: samples[0], hi: samples[0] };
	const rand = lcg(n * 2654435761);
	const means = new Array<number>(resamples);
	for (let r = 0; r < resamples; r++) {
		let sum = 0;
		for (let i = 0; i < n; i++) sum += samples[Math.floor(rand() * n)];
		means[r] = sum / n;
	}
	means.sort((a, b) => a - b);
	// Two-sided percentile from z. z=1.96 → 2.5/97.5.
	const tail = 1 - normalCdf(z);
	const lo = means[Math.max(0, Math.floor(tail * resamples))];
	const hi = means[Math.min(resamples - 1, Math.floor((1 - tail) * resamples))];
	return { lo, hi };
}

/**
 * Analytic Normal CI for a sample mean using the sample SD. Cheaper than
 * bootstrap and indistinguishable for n > 30; fall back to it when the
 * caller needs speed on a hot aggregation path.
 */
export function normalMeanCI(samples: number[], z = Z_95): Interval {
	const n = samples.length;
	if (n === 0) return { lo: 0, hi: 0 };
	if (n === 1) return { lo: samples[0], hi: samples[0] };
	let sum = 0;
	for (const x of samples) sum += x;
	const mean = sum / n;
	let sqErr = 0;
	for (const x of samples) sqErr += (x - mean) * (x - mean);
	const sd = Math.sqrt(sqErr / (n - 1));
	const se = sd / Math.sqrt(n);
	return { lo: mean - z * se, hi: mean + z * se };
}

/**
 * Z-score of `user` against a peer distribution with mean `peer` and
 * standard deviation `sd`. SD ≤ 0 yields z = 0 (we can't say anything).
 * Percentile returned in 0..100.
 */
export function zScore(user: number, peer: number, sd: number): ZScore {
	if (!isFinite(sd) || sd <= 0) {
		return { user, peer, sd: 0, z: 0, percentile: 50 };
	}
	const z = (user - peer) / sd;
	return { user, peer, sd, z, percentile: normalCdf(z) * 100 };
}

/**
 * Whether two intervals overlap at all. Used by severity gating to answer
 * "is the finding significantly different from peer?" — we require the
 * user's CI to *not* overlap the peer band before escalating.
 */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
	return a.lo <= b.hi && b.lo <= a.hi;
}

/**
 * Inverse regularised incomplete Beta via bisection. Only called for CI
 * endpoints so performance isn't critical. Returns x ∈ (0,1) such that
 * I_x(a, b) = p, accurate to ~1e-6.
 */
function invBetaCdf(p: number, a: number, b: number): number {
	if (p <= 0) return 0;
	if (p >= 1) return 1;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (betaCdf(mid, a, b) < p) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/**
 * Regularised incomplete Beta function via continued fraction (Lentz).
 * Adapted from Numerical Recipes; suitable for CI endpoint computation
 * where we need ~6 digits of precision.
 */
function betaCdf(x: number, a: number, b: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const bt = Math.exp(
		lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x)
	);
	if (x < (a + 1) / (a + b + 2)) {
		return (bt * betacf(x, a, b)) / a;
	}
	return 1 - (bt * betacf(1 - x, b, a)) / b;
}

function betacf(x: number, a: number, b: number): number {
	const MAX = 200;
	const EPS = 3e-7;
	const qab = a + b;
	const qap = a + 1;
	const qam = a - 1;
	let c = 1;
	let d = 1 - (qab * x) / qap;
	if (Math.abs(d) < 1e-30) d = 1e-30;
	d = 1 / d;
	let h = d;
	for (let m = 1; m <= MAX; m++) {
		const m2 = 2 * m;
		let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < 1e-30) d = 1e-30;
		c = 1 + aa / c;
		if (Math.abs(c) < 1e-30) c = 1e-30;
		d = 1 / d;
		h *= d * c;
		aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < 1e-30) d = 1e-30;
		c = 1 + aa / c;
		if (Math.abs(c) < 1e-30) c = 1e-30;
		d = 1 / d;
		const del = d * c;
		h *= del;
		if (Math.abs(del - 1) < EPS) break;
	}
	return h;
}

function lgamma(x: number): number {
	// Stirling approximation via Lanczos. Coefficients rounded to 15 digits,
	// the max double-precision can represent exactly — one extra digit would
	// silently drop at runtime and trip ESLint's precision check.
	const cof = [
		76.1800917294715, -86.5053203294168, 24.0140982408309, -1.23173957245015, 1.20865097386618e-3,
		-5.395239384953e-6
	];
	let y = x;
	let tmp = x + 5.5;
	tmp -= (x + 0.5) * Math.log(tmp);
	let ser = 1.00000000019002;
	for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
	return -tmp + Math.log((2.50662827463101 * ser) / x);
}

/**
 * Beta-Binomial posterior for a rate. Prior Beta(α, β) derived from a
 * peer mean `priorMean` and prior weight (effective sample size) `w`:
 *   α = priorMean · w,  β = (1 − priorMean) · w
 * Posterior after observing `k` successes in `n` trials is
 *   Beta(α + k, β + n − k)
 * with mean (α + k) / (α + β + n).
 *
 * `w` controls how aggressively thin user samples are pulled toward the
 * peer mean. The default w=20 says "treat the peer prior as worth 20
 * observations" — equivalent to observing 20 neutral games before the
 * user's own. Callers pick w based on the baseline bucket's sample size
 * (larger bucket → larger w, more confident prior).
 *
 * Returns a posterior mean and 80% credible interval. 80% not 95% because
 * tails are conservative on rate estimates and users understand ~1-in-5
 * better than ~1-in-20.
 */
export function betaBinomialPosterior(
	k: number,
	n: number,
	priorMean: number,
	priorWeight: number,
	{ ciWidth = 0.8 }: { ciWidth?: number } = {}
): PosteriorRate {
	const w = Math.max(1, priorWeight);
	const alpha0 = Math.max(1e-3, priorMean * w);
	const beta0 = Math.max(1e-3, (1 - priorMean) * w);
	const kk = Math.max(0, Math.min(n, k));
	const alpha = alpha0 + kk;
	const beta = beta0 + (n - kk);
	const mean = alpha / (alpha + beta);
	const tail = (1 - ciWidth) / 2;
	const ci: Interval = {
		lo: invBetaCdf(tail, alpha, beta),
		hi: invBetaCdf(1 - tail, alpha, beta)
	};
	return { mean, ci, effectiveN: alpha + beta, priorMean, priorWeight: w };
}

/**
 * Empirical-Bayes shrinkage for a per-bucket mean toward a grand mean.
 * Each bucket contributes its mean `x_i` with sample size `n_i`; the
 * shrinkage factor is `n_i / (n_i + n0)`, where n0 is the harmonic-mean
 * prior weight (default 20).
 *
 * Returns the shrunk mean per bucket, parallel to the input. Doesn't
 * change empty buckets (n_i = 0) — they stay at the grand mean.
 */
export function shrinkageMean(
	buckets: Array<{ mean: number; n: number }>,
	grandMean: number,
	priorN = 20
): number[] {
	return buckets.map((b) => {
		if (b.n === 0) return grandMean;
		const weight = b.n / (b.n + priorN);
		return weight * b.mean + (1 - weight) * grandMean;
	});
}

/**
 * Cohen's d effect size for two means with pooled SD. Used by level-up
 * and opening-fit callers that want to say "large" / "medium" / "small"
 * in a field-standard way. Doesn't produce a label here; caller decides.
 */
export function cohensD(
	a: { mean: number; sd: number; n: number },
	b: { mean: number; sd: number; n: number }
): number {
	const df = a.n + b.n - 2;
	if (df <= 0) return 0;
	const pooledVar = (Math.max(0, a.n - 1) * a.sd * a.sd + Math.max(0, b.n - 1) * b.sd * b.sd) / df;
	const pooledSd = Math.sqrt(Math.max(0, pooledVar));
	if (pooledSd <= 0) return 0;
	return (a.mean - b.mean) / pooledSd;
}

/**
 * Standard shorthand for percentile-from-z as a 0..100 number.
 * Factors out the repeated `normalCdf(z) * 100` in cards.
 */
export function percentileFromZ(z: number): number {
	return Math.max(0, Math.min(100, normalCdf(z) * 100));
}

/**
 * Format helpers so callers can render intervals consistently. Not side-
 * effectful; pure string formatters.
 */
export function formatInterval(i: Interval, digits = 1, pct = false): string {
	const mult = pct ? 100 : 1;
	const suffix = pct ? '%' : '';
	return `[${(i.lo * mult).toFixed(digits)}${suffix}–${(i.hi * mult).toFixed(digits)}${suffix}]`;
}

export function formatZ(z: number): string {
	const prefix = z >= 0 ? '+' : '−';
	return `${prefix}${Math.abs(z).toFixed(2)}σ`;
}

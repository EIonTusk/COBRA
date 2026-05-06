/**
 * Audit-style summary of a style scan. Produces:
 *
 *  - `verdict`: one-sentence top-line headline with the player's archetype,
 *    strength, and leak direction.
 *  - `keyFindings`: the two or three cards with the highest severity — what
 *    an audit would surface first.
 *  - `scope`: sample-size and methodology block (games, moves, eval depth,
 *    date range, baseline source).
 *  - `counts`: how many findings fell into each severity bucket.
 *  - `signalStrength`: thin / moderate / strong based on sample size. Stops
 *    the exec summary over-stating confidence on small scans.
 *
 * Kept separate from buildDeepInsightCards so the audit header can render
 * without needing the full card grid.
 */

import type { DossierScanResult } from './scan';
import {
	buildDeepInsightCards,
	type InsightCard,
	type Severity,
	severityRank
} from './deepInsights';
import { buildDossierProfile } from './profile';
import { pickBaseline, primarySpeed } from './fingerprint';
import { buildCriticalMoments } from './criticalMoments';

export interface AuditScope {
	accounts: string[];
	games: number;
	totalUserMoves: number;
	evalMovesAnalysed: number;
	evalDepth: number;
	dateFrom: number | null;
	dateTo: number | null;
	/**
	 * The user-set "games since" cutoff at scan time, or null if the scan
	 * was unbounded. Distinguishes "earliest game = X because we hit the
	 * cap" from "earliest game = X because the user excluded older play".
	 */
	sinceCutoff: number | null;
	baselineSource: string;
	baselineBucket: string | null;
}

export interface AuditSummary {
	verdict: string;
	keyFindings: InsightCard[];
	scope: AuditScope;
	counts: Record<Severity, number>;
	signalStrength: 'thin' | 'moderate' | 'strong';
	hasEval: boolean;
}

export function buildAuditSummary(result: DossierScanResult): AuditSummary {
	const cards = buildDeepInsightCards(result);
	const hasEval = !!result.evalAxes && result.evalAxes.movesAnalysed > 0;

	// Key findings: pick the highest-severity items, skipping "narrative"
	// because it's descriptive rather than a finding in the audit sense.
	const keyFindings = [...cards]
		.filter((c) => c.slug !== 'narrative' && c.severity !== 'inconclusive')
		.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
		.slice(0, 4);

	const counts: Record<Severity, number> = {
		strength: 0,
		observation: 0,
		concern: 0,
		critical: 0,
		inconclusive: 0
	};
	for (const c of cards) counts[c.severity] += 1;

	// Scope block.
	const accounts = Array.from(
		new Set(result.perAccount.map((p) => `${p.account.source}/${p.account.username}`))
	);
	const dateFrom =
		result.classified.length > 0 ? Math.min(...result.classified.map((g) => g.playedAt)) : null;
	const dateTo =
		result.classified.length > 0 ? Math.max(...result.classified.map((g) => g.playedAt)) : null;
	const baseline = pickBaseline(result.fingerprint.avgUserRating, primarySpeed(result.fingerprint));
	const scope: AuditScope = {
		accounts,
		games: result.classified.length,
		totalUserMoves: result.fingerprint.totalUserMoves,
		evalMovesAnalysed: result.evalAxes?.movesAnalysed ?? 0,
		evalDepth: result.evalDepth ?? 14,
		dateFrom,
		dateTo,
		sinceCutoff: result.sinceCutoff ?? null,
		baselineSource: baseline.source,
		baselineBucket: baseline.bucket
			? `${baseline.bucket.bucket ?? 'any'} · ${baseline.bucket.ratingMin}–${baseline.bucket.ratingMax} (${baseline.bucket.games} games)`
			: null
	};

	// Signal strength: games analysed + eval coverage.
	let signalStrength: AuditSummary['signalStrength'] = 'thin';
	if (scope.games >= 80 && (scope.evalMovesAnalysed >= 300 || !hasEval)) signalStrength = 'strong';
	else if (scope.games >= 30) signalStrength = 'moderate';

	// Verdict: one-sentence top-line, woven from the existing profile builder.
	const cm =
		hasEval && result.evalAxes
			? buildCriticalMoments(result.evalAxes.allMoves, baseline.criticalMoments ?? null)
			: null;
	const profile = buildDossierProfile(result.fingerprint, result.evalAxes, cm, baseline);

	let verdict =
		'Initial scan — play more rated games so the audit has enough signal to draw conclusions.';
	if (signalStrength !== 'thin' && profile.primary) {
		const strengthFragment = profile.primary.tagline.replace(/\.$/, '');
		const concerns = cards.filter((c) => c.severity === 'critical' || c.severity === 'concern');
		if (concerns.length === 0) {
			verdict = `${profile.primary.label}: ${strengthFragment}. No critical concerns in this report.`;
		} else {
			const worst = [...concerns].sort(
				(a, b) => severityRank(a.severity) - severityRank(b.severity)
			)[0];
			verdict = `${profile.primary.label}: ${strengthFragment}, but ${worst.title.toLowerCase()} is flagged — ${worst.headline.replace(/\.$/, '').toLowerCase()}.`;
		}
	} else if (signalStrength !== 'thin') {
		// No profile primary but we have signal — quote the top card.
		const top = keyFindings[0];
		if (top) verdict = `${top.title}: ${top.headline}`;
	}

	return { verdict, keyFindings, scope, counts, signalStrength, hasEval };
}

export function severityFraction(counts: Record<Severity, number>): {
	actionable: number;
	total: number;
} {
	const total = Object.values(counts).reduce((s, n) => s + n, 0);
	const actionable = counts.critical + counts.concern + counts.strength;
	return { actionable, total };
}

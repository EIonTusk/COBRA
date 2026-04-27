<script lang="ts">
	import type { AuditSummary } from '$lib/dossier/auditSummary';
	import type { Severity } from '$lib/dossier/deepInsights';
	import { severityDot, severityTint } from '$lib/dossier/format';

	interface Props {
		audit: AuditSummary;
	}

	let { audit }: Props = $props();

	const severityCountsView = $derived([
		{ sev: 'critical' as Severity, label: 'Critical', n: audit.counts.critical },
		{ sev: 'concern' as Severity, label: 'Concerns', n: audit.counts.concern },
		{ sev: 'strength' as Severity, label: 'Strengths', n: audit.counts.strength },
		{ sev: 'observation' as Severity, label: 'Observations', n: audit.counts.observation },
		{ sev: 'inconclusive' as Severity, label: 'Inconclusive', n: audit.counts.inconclusive }
	]);
</script>

<section id="section-1" class="mt-12 scroll-mt-6">
	<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">Section 1</div>
	<h2 class="mt-1 font-serif text-3xl text-[var(--color-parchment-50)]">Executive summary</h2>
	<div
		class="mt-4 max-w-3xl space-y-4 text-[15px] leading-relaxed text-[var(--color-parchment-200)]"
	>
		<p class="font-serif text-lg leading-snug text-[var(--color-parchment-50)]">
			{audit.verdict}
		</p>
		<p>
			The report draws on {audit.scope.games} rated games
			{#if audit.hasEval}
				(with {audit.scope.evalMovesAnalysed.toLocaleString()} moves cross-checked against a Stockfish
				depth-{audit.scope.evalDepth} NNUE reference)
			{/if}
			and classifies its {audit.keyFindings.length +
				audit.counts.observation +
				audit.counts.inconclusive}
			findings by severity. On this sample we recorded
			{audit.counts.critical} critical finding{audit.counts.critical === 1 ? '' : 's'},
			{audit.counts.concern} concern{audit.counts.concern === 1 ? '' : 's'},
			{audit.counts.strength} strength{audit.counts.strength === 1 ? '' : 's'}, and
			{audit.counts.observation} neutral observation{audit.counts.observation === 1 ? '' : 's'}.
			{#if audit.counts.inconclusive > 0}
				A further {audit.counts.inconclusive} finding{audit.counts.inconclusive === 1 ? '' : 's'}
				lacked sufficient sample size to rate confidently.
			{/if}
		</p>
	</div>

	<div class="mt-6 grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
		{#each severityCountsView as cv (cv.sev)}
			<div class="rounded border px-3 py-2 {severityTint(cv.sev)}">
				<div class="text-[10px] tracking-wider uppercase opacity-70">{cv.label}</div>
				<div class="mt-1 font-mono text-lg">{cv.n}</div>
			</div>
		{/each}
	</div>

	{#if audit.keyFindings.length > 0}
		<div
			class="mt-6 rounded border-l-2 border-[var(--color-brass-300)] bg-[var(--color-ink-900)] px-5 py-4"
		>
			<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
				Headline findings
			</div>
			<ol class="mt-2 space-y-2 text-sm text-[var(--color-parchment-200)]">
				{#each audit.keyFindings as c, i (c.slug)}
					<li class="flex items-start gap-2">
						<span
							class="mt-0.5 inline-block size-1.5 shrink-0 rounded-full {severityDot(c.severity)}"
						></span>
						<span>
							<span class="text-[var(--color-parchment-100)]">
								{i + 1}. {c.title}.
							</span>
							<span class="text-[var(--color-parchment-300)]">{c.headline}</span>
						</span>
					</li>
				{/each}
			</ol>
		</div>
	{/if}
</section>

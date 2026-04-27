<script lang="ts">
	import type { AuditSummary } from '$lib/dossier/auditSummary';
	import type { EvalAxesSummary } from '$lib/dossier/evalAxes';
	import { formatDateShort } from '$lib/dossier/format';

	interface Props {
		audit: AuditSummary;
		/** From `result.evalAxes`. Drives the optional eval-provenance line. */
		evalAxes: EvalAxesSummary | null;
		/** First account's username, e.g. `"henry"` — null when no accounts in scope. */
		reportUsername: string | null;
	}

	let { audit, evalAxes, reportUsername }: Props = $props();

	const fromLichess = $derived(evalAxes?.movesFromLichess ?? 0);
	const fromLocal = $derived(evalAxes?.movesFromLocal ?? 0);
</script>

<section class="mt-8 border-b-2 border-[var(--color-brass-300)]/60 pb-8">
	<div class="text-[10px] tracking-[0.25em] text-[var(--color-brass-300)] uppercase">
		Cobra Analytics · Dossier
	</div>
	<h1 class="mt-3 font-serif text-4xl leading-tight text-[var(--color-parchment-50)] sm:text-5xl">
		A review of {reportUsername ? `${reportUsername}'s` : 'your'} recent play
	</h1>
	<p class="mt-4 max-w-3xl text-sm leading-relaxed text-[var(--color-parchment-300)]">
		{audit.scope.games} rated games · {audit.scope.totalUserMoves.toLocaleString()} user moves ·
		{#if audit.scope.evalMovesAnalysed > 0}
			{audit.scope.evalMovesAnalysed.toLocaleString()} engine-analysed moves at depth {audit.scope
				.evalDepth} NNUE ·
		{/if}
		played {formatDateShort(audit.scope.dateFrom)} – {formatDateShort(audit.scope.dateTo)}.
	</p>
	{#if fromLichess > 0}
		<p class="mt-1 max-w-3xl text-xs text-[var(--color-parchment-500)]">
			Eval provenance: {fromLichess.toLocaleString()} adopted from Lichess ·
			{fromLocal.toLocaleString()} computed locally at depth {audit.scope.evalDepth} NNUE.
		</p>
	{/if}
	<div class="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--color-parchment-500)]">
		<span>Prepared {formatDateShort(Date.now())}</span>
		<span aria-hidden="true">·</span>
		<span>
			Signal strength:
			<span
				class="ml-1 font-mono {audit.signalStrength === 'strong'
					? 'text-emerald-400'
					: audit.signalStrength === 'moderate'
						? 'text-[var(--color-brass-300)]'
						: 'text-amber-300'}"
			>
				{audit.signalStrength}
			</span>
		</span>
		{#if audit.scope.accounts.length > 0}
			<span aria-hidden="true">·</span>
			<span class="font-mono">{audit.scope.accounts.join(', ')}</span>
		{/if}
	</div>
</section>

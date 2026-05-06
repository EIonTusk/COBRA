<script lang="ts">
	import type { AuditSummary } from '$lib/dossier/auditSummary';
	import type { EvalAxesSummary } from '$lib/dossier/evalAxes';
	import { MOVE_QUALITY_LABEL } from '$lib/dossier/sota';
	import { formatDateShort } from '$lib/dossier/format';

	interface Props {
		audit: AuditSummary;
		evalSummary: EvalAxesSummary | null;
	}

	let { audit, evalSummary }: Props = $props();
</script>

<section id="section-2" class="mt-12 scroll-mt-6">
	<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">Section 2</div>
	<h2 class="mt-1 font-serif text-3xl text-[var(--color-parchment-50)]">Scope and methodology</h2>
	<div
		class="mt-4 max-w-3xl space-y-4 text-[15px] leading-relaxed text-[var(--color-parchment-200)]"
	>
		<p>
			We ingested your most recent rated games from {audit.scope.accounts.length}
			account{audit.scope.accounts.length === 1 ? '' : 's'} and ran every user move through a board-feature
			extractor (piece role, captures, tension, pawn moves, destination file, demand heuristics).
			{#if audit.hasEval}
				A Stockfish NNUE pass at depth {audit.scope.evalDepth} scored each user move against the engine's
				preferred line, giving us centipawn-loss, classification (inaccuracy/mistake/blunder), and sac
				tendency.
			{:else}
				No engine pass was run for this report, so any finding that depends on centipawn loss has
				been marked <em>inconclusive</em>. Re-scan with Stockfish enabled to upgrade those.
			{/if}
		</p>
		<p>
			Peer benchmarks come from the
			<span class="font-mono text-[var(--color-parchment-100)]">{audit.scope.baselineSource}</span>
			baseline
			{#if audit.scope.baselineBucket}
				({audit.scope.baselineBucket})
			{/if}
			— players at your rating band and primary speed. Findings are classified as
			<em>critical</em>, <em>concern</em>, <em>strength</em>, <em>observation</em>, or
			<em>inconclusive</em> using thresholds set on each individual finding (e.g. endgame conversion
			below 50% is <em>critical</em>; prophylaxis neutralise rate above 65% is a <em>strength</em>).
		</p>
	</div>

	<dl
		class="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-5 py-4 text-xs sm:grid-cols-3"
	>
		<div>
			<dt class="text-[var(--color-parchment-500)]">Accounts</dt>
			<dd class="mt-0.5 font-mono text-[var(--color-parchment-100)]">
				{audit.scope.accounts.join(', ') || '—'}
			</dd>
		</div>
		<div>
			<dt class="text-[var(--color-parchment-500)]">Games</dt>
			<dd class="mt-0.5 font-mono text-[var(--color-parchment-100)]">
				{audit.scope.games}
			</dd>
		</div>
		<div>
			<dt class="text-[var(--color-parchment-500)]">User moves</dt>
			<dd class="mt-0.5 font-mono text-[var(--color-parchment-100)]">
				{audit.scope.totalUserMoves.toLocaleString()}
			</dd>
		</div>
		<div>
			<dt class="text-[var(--color-parchment-500)]">Engine moves</dt>
			<dd class="mt-0.5 font-mono text-[var(--color-parchment-100)]">
				{audit.scope.evalMovesAnalysed.toLocaleString()}
				{#if audit.hasEval}
					<span class="text-[var(--color-parchment-500)]">· depth {audit.scope.evalDepth}</span>
				{/if}
			</dd>
		</div>
		<div>
			<dt class="text-[var(--color-parchment-500)]">Date range</dt>
			<dd class="mt-0.5 font-mono text-[var(--color-parchment-100)]">
				{formatDateShort(audit.scope.dateFrom)} → {formatDateShort(audit.scope.dateTo)}
				{#if audit.scope.sinceCutoff != null}
					<span
						class="text-[var(--color-parchment-500)]"
						title="Older games were excluded by the user-set Game query window"
					>
						· cutoff {formatDateShort(audit.scope.sinceCutoff)}
					</span>
				{/if}
			</dd>
		</div>
		<div>
			<dt class="text-[var(--color-parchment-500)]">Peer baseline</dt>
			<dd class="mt-0.5 font-mono text-[var(--color-parchment-100)]">
				{audit.scope.baselineSource}{audit.scope.baselineBucket
					? ` · ${audit.scope.baselineBucket}`
					: ''}
			</dd>
		</div>
	</dl>

	<!-- Move-quality histogram + headline accuracy. Promoted out of the
	     appendix because it's a core summary of *how well you played*.
	     Accuracy uses the Lichess WP-loss sigmoid rather than raw CP
	     loss so a 50cp drop in a balanced position counts very
	     differently from the same drop when already lost. -->
	{#if evalSummary && evalSummary.movesAnalysed > 0}
		<div
			class="mt-5 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-5 py-4"
		>
			<div class="flex flex-wrap items-baseline justify-between gap-3">
				<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
					Move-quality histogram · Lichess-style WP accuracy
				</div>
				<div class="flex flex-wrap gap-2 text-xs">
					<span
						class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-0.5 text-[var(--color-parchment-200)]"
					>
						Accuracy:
						<span class="font-mono text-[var(--color-parchment-100)]">
							{evalSummary.avgAccuracy.toFixed(1)}%
						</span>
					</span>
					<span
						class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-0.5 text-[var(--color-parchment-200)]"
					>
						Tactical moves:
						<span class="font-mono text-[var(--color-parchment-100)]">
							{(evalSummary.tacticalMoveRate * 100).toFixed(1)}%
						</span>
					</span>
				</div>
			</div>

			<div class="mt-3 space-y-1 text-xs">
				{#each evalSummary.histogram as b (b.quality)}
					{@const color =
						b.quality === 'brilliant'
							? 'bg-sky-400/70'
							: b.quality === 'best'
								? 'bg-emerald-500/70'
								: b.quality === 'excellent'
									? 'bg-emerald-400/55'
									: b.quality === 'good'
										? 'bg-[var(--color-brass-300)]/70'
										: b.quality === 'inaccuracy'
											? 'bg-amber-300/70'
											: b.quality === 'mistake'
												? 'bg-amber-500/70'
												: 'bg-red-500/70'}
					<div
						class="grid grid-cols-[minmax(0,5rem)_1fr_3rem_2.5rem] items-center gap-2 sm:grid-cols-[7rem_1fr_3.5rem_3rem]"
					>
						<span class="text-[var(--color-parchment-200)]">
							{MOVE_QUALITY_LABEL[b.quality]}
						</span>
						<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
							<div
								class="h-full rounded {color}"
								style:width="{Math.max(2, b.share * 100).toFixed(1)}%"
							></div>
						</div>
						<span class="text-right font-mono text-[var(--color-parchment-100)]">
							{(b.share * 100).toFixed(1)}%
						</span>
						<span class="text-right font-mono text-[var(--color-parchment-500)]">
							{b.count}
						</span>
					</div>
				{/each}
			</div>

			<div class="mt-3 flex flex-wrap gap-3 text-[10px] text-[var(--color-parchment-500)]">
				<span>Avg WP loss: <span class="font-mono">{evalSummary.avgWpLoss.toFixed(2)}pp</span></span
				>
				{#if evalSummary.multiPv}
					<span>Multi-PV 3</span>
				{/if}
				{#if evalSummary.usedMastersBook && evalSummary.movesSkippedBook > 0}
					<span>Skipped {evalSummary.movesSkippedBook} book moves</span>
				{/if}
				{#if evalSummary.usedTablebase}
					<span>Syzygy tablebase on for ≤ 7 pieces</span>
				{/if}
			</div>
		</div>
	{/if}
</section>

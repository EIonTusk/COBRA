<script lang="ts">
	import type { EvalAxesSummary } from '$lib/dossier/evalAxes';
	import { PHASE_LABEL, lichessAnalysisUrl, pct } from '$lib/dossier/format';

	interface Props {
		/** Two-way bound number input — recent-game cap for the local engine pass. */
		gameCap: number;
		/** Whether a run is currently in flight. */
		running: boolean;
		/** Progress string of the form "done/total". Empty when not running. */
		progress: string;
		/** Last error message from a failed run, or null. */
		error: string | null;
		/** Result summary, or null if no run has produced one yet. */
		summary: EvalAxesSummary | null;
		/** Kick off a fresh run. */
		onRun: () => void;
		/** Abort an in-flight run. No-op if not running. */
		onAbort: () => void;
	}

	let {
		gameCap = $bindable(),
		running,
		progress,
		error,
		summary,
		onRun,
		onAbort
	}: Props = $props();
</script>

<section class="mt-8">
	<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
		Appendix J
	</div>
	<h2 class="font-serif text-xl">Eval-based axes (Stockfish)</h2>
	<p class="text-xs text-[var(--color-parchment-500)]">
		Runs the local engine over every move of the most-recent N games. Adds CP loss,
		blunder/inaccuracy rates per phase, and a sac-tendency axis (material-loss moves the engine
		endorses). Heavy: ~12s per game at depth 14, fully local.
	</p>

	<div class="mt-3 flex flex-wrap items-end gap-3 text-xs">
		<label class="flex flex-col gap-1">
			<span class="text-[var(--color-parchment-500)]">Recent games</span>
			<input
				type="number"
				bind:value={gameCap}
				min="1"
				max="40"
				class="w-24 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-1"
			/>
		</label>
		<button
			type="button"
			onclick={onRun}
			disabled={running}
			class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-1 hover:border-[var(--color-brass-300)]/40 disabled:opacity-50"
		>
			{running ? `Analysing ${progress}…` : 'Run eval-based analysis'}
		</button>
		{#if running}
			<button type="button" onclick={onAbort} class="text-[var(--color-parchment-400)] underline">
				Cancel
			</button>
		{/if}
		{#if error}
			<span class="text-red-400">{error}</span>
		{/if}
	</div>

	{#if summary}
		{@const skipped =
			summary.movesSkippedSan + summary.movesSkippedEngine + summary.movesSkippedNoScore}
		{#if skipped > 0}
			<div
				class="mt-3 rounded border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
			>
				Skipped {skipped} of {summary.movesAnalysed + skipped} moves —
				{summary.movesSkippedSan} SAN-parse, {summary.movesSkippedEngine} engine reject, {summary.movesSkippedNoScore}
				no-score.
				{#if summary.firstError}
					<span class="block font-mono text-[11px] opacity-80">{summary.firstError}</span>
				{/if}
			</div>
		{/if}
		<div class="mt-4 grid gap-3 sm:grid-cols-4">
			<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2">
				<div class="text-xs text-[var(--color-parchment-500)]">Avg CP loss</div>
				<div class="mt-1 font-mono text-lg">
					{(summary.avgCpLoss / 100).toFixed(2)}
					<span class="text-xs text-[var(--color-parchment-500)]">pawns</span>
				</div>
				<div class="text-xs text-[var(--color-parchment-500)]">
					across {summary.movesAnalysed} moves
				</div>
			</div>
			<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2">
				<div class="text-xs text-[var(--color-parchment-500)]">Blunder rate</div>
				<div class="mt-1 font-mono text-lg">{pct(summary.blunderRate)}</div>
				<div class="text-xs text-[var(--color-parchment-500)]">≥2 pawns lost</div>
			</div>
			<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2">
				<div class="text-xs text-[var(--color-parchment-500)]">Inaccuracy rate</div>
				<div class="mt-1 font-mono text-lg">{pct(summary.inaccuracyRate)}</div>
				<div class="text-xs text-[var(--color-parchment-500)]">0.5–2 pawns lost</div>
			</div>
			<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2">
				<div class="text-xs text-[var(--color-parchment-500)]">Sac tendency</div>
				<div class="mt-1 font-mono text-lg">{pct(summary.sacTendency)}</div>
				<div class="text-xs text-[var(--color-parchment-500)]">
					material loss the engine endorses
				</div>
			</div>
		</div>

		<h3 class="mt-5 font-serif text-lg">By phase</h3>
		<div class="mt-2 overflow-x-auto">
			<table class="w-full border-collapse text-sm">
				<thead class="text-left text-xs text-[var(--color-parchment-500)]">
					<tr>
						<th class="py-2 pr-4">Phase</th>
						<th class="py-2 pr-4">Moves</th>
						<th class="py-2 pr-4">Avg CP loss</th>
						<th class="py-2 pr-4">Blunder</th>
						<th class="py-2 pr-4">Inaccuracy</th>
					</tr>
				</thead>
				<tbody>
					{#each ['opening', 'middle', 'end'] as const as phase (phase)}
						{@const p = summary.byPhase[phase]}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-2 pr-4 font-medium">{PHASE_LABEL[phase]}</td>
							<td class="py-2 pr-4 font-mono">{p.moves}</td>
							<td class="py-2 pr-4 font-mono">{(p.avgCpLoss / 100).toFixed(2)}</td>
							<td class="py-2 pr-4 font-mono">{pct(p.blunderRate)}</td>
							<td class="py-2 pr-4 font-mono">{pct(p.inaccuracyRate)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if summary.worst.length > 0}
			<h3 class="mt-5 font-serif text-lg">Worst CP-loss moves</h3>
			<ol class="mt-2 space-y-1 text-sm">
				{#each summary.worst as w (w.gameId + w.ply)}
					<li
						class="flex flex-wrap items-baseline justify-between gap-2 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2"
					>
						<div>
							<span class="font-mono">{w.san}</span>
							<span class="ml-2 text-xs text-[var(--color-parchment-500)]">
								{w.classification} · {w.phase} · ply {w.ply}
							</span>
							<span
								class="ml-2 rounded bg-[var(--color-ink-950)] px-1.5 py-0.5 font-mono text-xs"
								class:text-amber-300={w.cpLoss >= 200}
								class:text-emerald-400={w.intentionalSac}
							>
								−{(w.cpLoss / 100).toFixed(2)} pawns{w.intentionalSac ? ' (sac)' : ''}
							</span>
						</div>
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<a
							href={lichessAnalysisUrl(w.fenBefore)}
							target="_blank"
							rel="noopener"
							class="text-xs text-[var(--color-brass-300)] underline"
						>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							Open on Lichess
						</a>
					</li>
				{/each}
			</ol>
		{/if}
	{/if}
</section>

<script lang="ts">
	import { resolve } from '$app/paths';
	import type { LeakSummary, LeakInstance } from '$lib/dossier/mismatch';
	import type { Repertoire } from '$lib/types';
	import { lichessAnalysisUrl, pct } from '$lib/dossier/format';

	const LEAK_LABEL = {
		missed_capture: 'Missed capture',
		impatient_forcing: 'Impatient forcing',
		missed_attack: 'Missed attack'
	} as const;

	function leakRowId(l: LeakInstance): string {
		return `${l.gameId}:${l.ply}`;
	}

	interface Props {
		leaks: LeakSummary;
		repertoires: Repertoire[];
		/** Two-way bound — the repertoire selector here also controls the
		 *  Blunder Atlas's "Drill these" target. */
		drillRepId: string;
		/** Set of leak-row ids already saved as drills, for showing a "Saved ✓" pill. */
		savedLeakIds: Set<string>;
		/** Map from leakRowId → CP loss after the deep-analyse pass. */
		cpLossByLeakRow: Map<string, number>;
		/** Per-leak-type avg CP loss after deep analyse, or null if not run yet. */
		analysedAvg: Record<string, number> | null;
		/** Whether a deep-analyse pass is in flight. */
		analysing: boolean;
		/** Progress string of the form "done/total". */
		analyseProgress: string;
		/** Last error message from deep analyse, or null. */
		analyseError: string | null;
		/** Status banner shown after a bulk-save action. */
		saveAllStatus: string;
		onDeepAnalyse: () => void;
		onSaveAll: () => void;
		onSaveLeak: (leak: LeakInstance) => void;
	}

	let {
		leaks,
		repertoires,
		drillRepId = $bindable(),
		savedLeakIds,
		cpLossByLeakRow,
		analysedAvg,
		analysing,
		analyseProgress,
		analyseError,
		saveAllStatus,
		onDeepAnalyse,
		onSaveAll,
		onSaveLeak
	}: Props = $props();
</script>

<section class="mt-8">
	<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
		Appendix H
	</div>
	<h2 class="font-serif text-xl">Leak detector</h2>
	<p class="text-xs text-[var(--color-parchment-500)]">
		Positions where your habitual response didn't match what the position asked for. v1: board-only
		heuristics, no engine — false negatives expected, false positives kept low.
	</p>
	<div class="mt-3 grid gap-3 sm:grid-cols-3">
		<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2">
			<div class="text-xs text-[var(--color-parchment-500)]">Missed captures</div>
			<div class="mt-1 font-mono text-lg">
				{leaks.counts.missed_capture}
				<span class="text-xs text-[var(--color-parchment-500)]"
					>({pct(leaks.rates.missed_capture)} of moves)</span
				>
			</div>
			<div class="mt-1 text-xs text-[var(--color-parchment-500)]">
				op {leaks.byPhase.opening.missed_capture} · mid {leaks.byPhase.middle.missed_capture} · end {leaks
					.byPhase.end.missed_capture}
			</div>
		</div>
		<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2">
			<div class="text-xs text-[var(--color-parchment-500)]">Impatient forcing</div>
			<div class="mt-1 font-mono text-lg">
				{leaks.counts.impatient_forcing}
				<span class="text-xs text-[var(--color-parchment-500)]"
					>({pct(leaks.rates.impatient_forcing)} of moves)</span
				>
			</div>
			<div class="mt-1 text-xs text-[var(--color-parchment-500)]">
				op {leaks.byPhase.opening.impatient_forcing} · mid {leaks.byPhase.middle.impatient_forcing}
				· end {leaks.byPhase.end.impatient_forcing}
			</div>
		</div>
		<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2">
			<div class="text-xs text-[var(--color-parchment-500)]">Missed attacks</div>
			<div class="mt-1 font-mono text-lg">
				{leaks.counts.missed_attack}
				<span class="text-xs text-[var(--color-parchment-500)]"
					>({pct(leaks.rates.missed_attack)} of moves)</span
				>
			</div>
			<div class="mt-1 text-xs text-[var(--color-parchment-500)]">
				op {leaks.byPhase.opening.missed_attack} · mid {leaks.byPhase.middle.missed_attack} · end {leaks
					.byPhase.end.missed_attack}
			</div>
		</div>
	</div>

	{#if leaks.worst.length > 0}
		<div class="mt-5 flex flex-wrap items-end gap-2">
			<button
				type="button"
				onclick={onDeepAnalyse}
				disabled={analysing}
				class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-1 text-xs hover:border-[var(--color-brass-300)]/40 disabled:opacity-50"
			>
				{analysing ? `Analysing ${analyseProgress}…` : 'Deep-analyse worst leaks (Stockfish)'}
			</button>
			{#if analyseError}
				<span class="text-xs text-red-400">{analyseError}</span>
			{/if}
		</div>
		{#if analysedAvg}
			<div class="mt-3 grid gap-2 text-xs sm:grid-cols-3">
				{#each Object.entries(analysedAvg) as [type, cp] (type)}
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2"
					>
						<div class="text-[var(--color-parchment-500)]">
							avg CP loss · {LEAK_LABEL[type as keyof typeof LEAK_LABEL] ?? type}
						</div>
						<div class="mt-1 font-mono text-base">{(cp / 100).toFixed(2)} pawns</div>
					</div>
				{/each}
			</div>
		{/if}

		<div class="mt-5 flex flex-wrap items-end justify-between gap-3">
			<h3 class="font-serif text-lg">Worst offenders</h3>
			{#if repertoires.length > 0}
				<div class="flex flex-wrap items-end gap-2 text-xs">
					<label class="flex flex-col gap-1">
						<span class="text-[var(--color-parchment-500)]">Save drills under</span>
						<select
							bind:value={drillRepId}
							class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-1"
						>
							{#each repertoires as r (r.id)}
								<option value={r.id}>{r.name}</option>
							{/each}
						</select>
					</label>
					<button
						type="button"
						onclick={onSaveAll}
						disabled={!drillRepId}
						class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-1 hover:border-[var(--color-brass-300)]/40 disabled:opacity-50"
					>
						Save all worst as drills
					</button>
				</div>
			{:else}
				<p class="text-xs text-[var(--color-parchment-500)]">
					Create a repertoire to save leaks as drills.
				</p>
			{/if}
		</div>
		{#if saveAllStatus}
			<p class="mt-2 text-xs text-[var(--color-parchment-400)]">{saveAllStatus}</p>
		{/if}
		<ol class="mt-2 space-y-1 text-sm">
			{#each leaks.worst as l (l.gameId + l.ply)}
				{@const saved = savedLeakIds.has(leakRowId(l))}
				{@const cp = cpLossByLeakRow.get(leakRowId(l))}
				<li
					class="flex flex-wrap items-baseline justify-between gap-2 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2"
				>
					<div>
						<span class="font-mono">{l.san}</span>
						<span class="ml-2 text-xs text-[var(--color-parchment-500)]"
							>{LEAK_LABEL[l.type]} · {l.phase} · ply {l.ply}{l.bestCaptureGain
								? ` · missed +${l.bestCaptureGain}`
								: ''}</span
						>
						{#if cp != null}
							<span
								class="ml-2 rounded bg-[var(--color-ink-950)] px-1.5 py-0.5 font-mono text-xs"
								class:text-amber-300={cp >= 100}
								class:text-emerald-400={cp < 30}
							>
								−{(cp / 100).toFixed(2)} pawns
							</span>
						{/if}
					</div>
					<div class="flex items-center gap-3 text-xs">
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<a
							href={lichessAnalysisUrl(l.fenBefore)}
							target="_blank"
							rel="noopener"
							class="text-[var(--color-brass-300)] underline"
						>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							Open on Lichess
						</a>
						{#if drillRepId}
							{#if saved}
								<span class="text-[var(--color-parchment-500)]">Saved ✓</span>
							{:else}
								<button
									type="button"
									onclick={() => onSaveLeak(l)}
									class="rounded border border-[var(--color-ink-700)] px-2 py-0.5 hover:border-[var(--color-brass-300)]/40"
								>
									Save as drill
								</button>
							{/if}
						{/if}
					</div>
				</li>
			{/each}
		</ol>
		{#if drillRepId}
			<p class="mt-3 text-xs text-[var(--color-parchment-500)]">
				Saved drills appear in <a class="underline" href={resolve('/mistakes')}>Mistakes</a> under the
				chosen repertoire.
			</p>
		{/if}
	{/if}
</section>

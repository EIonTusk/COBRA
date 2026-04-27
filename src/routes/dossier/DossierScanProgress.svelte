<script lang="ts">
	import type { DossierScanPhase } from '$lib/dossier/scanStore.svelte';

	interface Props {
		phase: DossierScanPhase;
		gamesDone: number;
		/** Per-account fetch status text shown under the fetch row. */
		progressText: string;
		evalTotal: number;
		evalDone: number;
		/** evalDone / evalTotal precomputed by the page, since several other
		 *  blocks read the same fraction. */
		evalFraction: number;
	}

	let { phase, gamesDone, progressText, evalTotal, evalDone, evalFraction }: Props = $props();
</script>

<div class="mt-3 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-3">
	<!-- Stage 1: fetching games -->
	<div class="flex items-baseline justify-between gap-2">
		<div class="flex items-center gap-2 text-xs">
			{#if phase === 'fetching'}
				<span class="inline-block size-1.5 animate-pulse rounded-full bg-[var(--color-brass-300)]"
				></span>
				<span class="text-[var(--color-parchment-200)]">Fetching games</span>
			{:else if phase === 'analysing' || phase === 'done'}
				<span class="inline-block size-1.5 rounded-full bg-emerald-400"></span>
				<span class="text-[var(--color-parchment-400)]">Games fetched</span>
			{:else}
				<span class="inline-block size-1.5 rounded-full bg-[var(--color-ink-700)]"></span>
				<span class="text-[var(--color-parchment-500)]">Fetch games</span>
			{/if}
		</div>
		<span class="font-mono text-xs text-[var(--color-parchment-500)]">
			{gamesDone} games
		</span>
	</div>
	{#if phase === 'fetching' && progressText}
		<p class="mt-1 text-[10px] text-[var(--color-parchment-500)]">{progressText}</p>
	{/if}

	<!-- Stage 2: Stockfish analysis -->
	<div class="mt-3 flex items-baseline justify-between gap-2">
		<div class="flex items-center gap-2 text-xs">
			{#if phase === 'analysing'}
				<span class="inline-block size-1.5 animate-pulse rounded-full bg-[var(--color-brass-300)]"
				></span>
				<span class="text-[var(--color-parchment-200)]">Analysing with Stockfish</span>
			{:else if phase === 'done'}
				<span class="inline-block size-1.5 rounded-full bg-emerald-400"></span>
				<span class="text-[var(--color-parchment-400)]">Analysis complete</span>
			{:else}
				<span class="inline-block size-1.5 rounded-full bg-[var(--color-ink-700)]"></span>
				<span class="text-[var(--color-parchment-500)]">Analyse with Stockfish</span>
			{/if}
		</div>
		<span class="font-mono text-xs text-[var(--color-parchment-500)]">
			{#if evalTotal > 0}
				{evalDone} / {evalTotal} moves
			{:else}
				—
			{/if}
		</span>
	</div>
	<div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-ink-950)]">
		<div
			class="h-full rounded-full bg-[var(--color-brass-300)] transition-[width] duration-150"
			style="width: {phase === 'done' ? 100 : evalTotal > 0 ? evalFraction * 100 : 0}%"
		></div>
	</div>
	{#if phase === 'analysing' && evalTotal > 0}
		<p class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
			{Math.round(evalFraction * 100)}% · depth 14 NNUE
		</p>
	{/if}
</div>

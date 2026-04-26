<script lang="ts">
	import { baselineCalibration } from './baselineCalibrationStore.svelte';

	const phase = $derived(baselineCalibration.phase);
	const progressText = $derived(baselineCalibration.progressText);
	const fraction = $derived(baselineCalibration.fraction);

	const fetchDone = $derived(phase === 'snowball' || phase === 'engine' || phase === 'done');
	const snowballActive = $derived(phase === 'snowball');
	const snowballDone = $derived(phase === 'engine' || phase === 'done');
	const engineActive = $derived(phase === 'engine');
	const engineDone = $derived(phase === 'done');

	// Numeric counters parsed from the progress text. The store hands us
	// `calibrate: 12/30 · username` and `engine: 1234/5678 moves`; pulling
	// the numbers out lets us render a "12 / 30" counter on the right of
	// each row, mirroring the dossier scan layout. Falls back to dashes when
	// the text shape doesn't match (early or done state).
	const counters = $derived.by(() => {
		const m = progressText.match(/(\d+)\s*\/\s*(\d+)/);
		if (!m) return { done: 0, total: 0 };
		return { done: Number(m[1]), total: Number(m[2]) };
	});
</script>

<div class="mt-3 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-3">
	<!-- Stage 1: fetching the user's own games -->
	<div class="flex items-baseline justify-between gap-2">
		<div class="flex items-center gap-2 text-xs">
			{#if phase === 'fetching'}
				<span class="inline-block size-1.5 animate-pulse rounded-full bg-[var(--color-brass-300)]"
				></span>
				<span class="text-[var(--color-parchment-200)]">Fetching your games</span>
			{:else if fetchDone}
				<span class="inline-block size-1.5 rounded-full bg-emerald-400"></span>
				<span class="text-[var(--color-parchment-400)]">Games fetched</span>
			{:else}
				<span class="inline-block size-1.5 rounded-full bg-[var(--color-ink-700)]"></span>
				<span class="text-[var(--color-parchment-500)]">Fetch your games</span>
			{/if}
		</div>
		{#if phase === 'fetching' && progressText}
			<span class="truncate font-mono text-[10px] text-[var(--color-parchment-500)]"
				>{progressText}</span
			>
		{/if}
	</div>

	<!-- Stage 2: snowball over peer opponents -->
	<div class="mt-3 flex items-baseline justify-between gap-2">
		<div class="flex items-center gap-2 text-xs">
			{#if snowballActive}
				<span class="inline-block size-1.5 animate-pulse rounded-full bg-[var(--color-brass-300)]"
				></span>
				<span class="text-[var(--color-parchment-200)]">Walking peer opponents</span>
			{:else if snowballDone}
				<span class="inline-block size-1.5 rounded-full bg-emerald-400"></span>
				<span class="text-[var(--color-parchment-400)]">Peers walked</span>
			{:else}
				<span class="inline-block size-1.5 rounded-full bg-[var(--color-ink-700)]"></span>
				<span class="text-[var(--color-parchment-500)]">Walk peer opponents</span>
			{/if}
		</div>
		<span class="font-mono text-xs text-[var(--color-parchment-500)]">
			{#if snowballActive && counters.total > 0}
				{counters.done} / {counters.total} peers
			{:else}
				—
			{/if}
		</span>
	</div>
	<div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-ink-950)]">
		<div
			class="h-full rounded-full bg-[var(--color-brass-300)] transition-[width] duration-150"
			style="width: {snowballDone ? 100 : snowballActive && fraction != null ? fraction * 100 : 0}%"
		></div>
	</div>

	<!-- Stage 3: optional engine pass over a sample of peer games -->
	<div class="mt-3 flex items-baseline justify-between gap-2">
		<div class="flex items-center gap-2 text-xs">
			{#if engineActive}
				<span class="inline-block size-1.5 animate-pulse rounded-full bg-[var(--color-brass-300)]"
				></span>
				<span class="text-[var(--color-parchment-200)]">Analysing peer games (Stockfish)</span>
			{:else if engineDone}
				<span class="inline-block size-1.5 rounded-full bg-emerald-400"></span>
				<span class="text-[var(--color-parchment-400)]">Engine pass complete</span>
			{:else}
				<span class="inline-block size-1.5 rounded-full bg-[var(--color-ink-700)]"></span>
				<span class="text-[var(--color-parchment-500)]">Analyse peer games</span>
			{/if}
		</div>
		<span class="font-mono text-xs text-[var(--color-parchment-500)]">
			{#if engineActive && counters.total > 0}
				{counters.done} / {counters.total} moves
			{:else}
				—
			{/if}
		</span>
	</div>
	{#if engineActive && fraction != null}
		<div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-ink-950)]">
			<div
				class="h-full rounded-full bg-[var(--color-brass-300)] transition-[width] duration-150"
				style="width: {fraction * 100}%"
			></div>
		</div>
		<p class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
			{Math.round(fraction * 100)}% · peer engine pass
		</p>
	{/if}
</div>

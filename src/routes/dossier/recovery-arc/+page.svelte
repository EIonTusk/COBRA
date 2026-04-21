<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseRecoveryArc } from '$lib/dossier/recoveryArc';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(result ? analyseRecoveryArc(result.evalAxes?.allMoves ?? null) : null);

	const maxCp = $derived(summary ? Math.max(...summary.points.map((p) => p.avgCpLoss), 1) : 1);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}
</script>

<DossierSubpageShell
	title="Recovery arc"
	subtitle="What your CP loss looks like on the 5 user moves immediately after your own blunder. Do you steady up or does one slip spiral into a collapse?"
	{loaded}
	hasReport={!!result}
>
	{#if !result?.evalAxes}
		<div
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-4 text-sm"
		>
			This page needs an engine-analysed report.
		</div>
	{:else if summary}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Headline</div>
			<div class="mt-3 grid grid-cols-3 gap-3 text-xs">
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Blunders analysed</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.totalBlunders}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Cascade rate (3 moves)</div>
					<div class="mt-1 font-mono text-lg text-amber-300">{pct(summary.cascadeRate)}</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Steady rate (3 moves)</div>
					<div class="mt-1 font-mono text-lg text-emerald-300">{pct(summary.steadyRate)}</div>
				</div>
			</div>
			<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
				Cascade = another blunder within 3 moves. Steady = 3 consecutive moves at ≤30cp loss.
			</p>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				CP loss at each offset after blunder
			</div>
			<div class="mt-3 space-y-2 text-xs">
				{#each summary.points as p (p.offset)}
					<div class="flex items-center gap-2">
						<div class="w-16 text-[var(--color-parchment-300)]">
							{p.offset === 0 ? 'Blunder' : `+${p.offset}`}
						</div>
						<div class="h-2 flex-1 rounded bg-[var(--color-ink-950)]">
							<div
								class="h-full rounded {p.offset === 0 ? 'bg-red-500/60' : 'bg-amber-500/60'}"
								style:width="{Math.min(100, (p.avgCpLoss / maxCp) * 100).toFixed(1)}%"
							></div>
						</div>
						<div class="w-32 text-right font-mono">
							{p.avgCpLoss.toFixed(1)}cp
							<span class="text-[10px] text-[var(--color-parchment-500)]">({p.moves})</span>
						</div>
					</div>
				{/each}
			</div>
			<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
				If the bars shrink quickly from +1 to +5, you steady up. If they stay high or grow, one
				mistake tends to become two.
			</p>
		</section>
	{/if}
</DossierSubpageShell>

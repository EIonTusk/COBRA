<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { listStoredBaselines } from '$lib/storage/baselines';
	import { setRuntimeBaselines } from '$lib/dossier/fingerprint';
	import { buildLevelUp, AXIS_LABEL } from '$lib/dossier/levelUp';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);
	let offset = $state(200);

	onMount(async () => {
		const stored = await listStoredBaselines();
		setRuntimeBaselines(stored);
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(result ? buildLevelUp(result.fingerprint, offset) : null);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}
	function signedPct(x: number) {
		return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`;
	}
</script>

<DossierSubpageShell
	title="Level-up diff"
	subtitle="How your style axes differ from the typical player at a higher rating. Use this to see which direction your style should drift as you climb."
	{loaded}
	hasReport={!!result}
>
	{#if summary}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="flex flex-wrap items-end justify-between gap-3">
				<div>
					<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
						Target rating
					</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.sourceRating ?? '—'} → {summary.targetRating || 'baseline'}
					</div>
					<div class="text-xs text-[var(--color-parchment-500)]">
						Baseline source: <span class="font-mono">{summary.targetSource}</span>
					</div>
				</div>
				<label class="flex items-center gap-2 text-xs">
					<span class="text-[var(--color-parchment-400)]">Offset</span>
					<input type="range" min="50" max="400" step="25" bind:value={offset} class="w-32" />
					<span class="font-mono text-[var(--color-parchment-100)]">+{offset}</span>
				</label>
			</div>
		</section>

		{#if summary.biggestGap}
			<section
				class="mt-6 rounded border border-emerald-500/40 bg-emerald-950/15 px-4 py-4 text-sm"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
					Biggest gap
				</div>
				<p class="mt-2 text-[var(--color-parchment-100)]">
					{AXIS_LABEL[summary.biggestGap.axis]} — players at +{offset} run it at
					<span class="font-mono">{pct(summary.biggestGap.target)}</span>
					vs your <span class="font-mono">{pct(summary.biggestGap.you)}</span>
					({signedPct(summary.biggestGap.delta)}).
					{#if summary.biggestGap.direction === 'raise'}
						Practise playing {AXIS_LABEL[summary.biggestGap.axis].toLowerCase()} more assertively.
					{:else if summary.biggestGap.direction === 'lower'}
						Dial {AXIS_LABEL[summary.biggestGap.axis].toLowerCase()} back a touch.
					{/if}
				</p>
			</section>
		{/if}

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">All axes</div>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Axis</th>
						<th class="text-right">You</th>
						<th class="text-right">Target</th>
						<th class="text-right">Delta</th>
						<th class="text-left">Action</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.diffs as d (d.axis)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{AXIS_LABEL[d.axis]}</td>
							<td class="py-1.5 text-right">{pct(d.you)}</td>
							<td class="py-1.5 text-right">{pct(d.target)}</td>
							<td
								class="py-1.5 text-right {d.magnitude > 0.02
									? d.delta > 0
										? 'text-emerald-400'
										: 'text-amber-300'
									: ''}"
							>
								{signedPct(d.delta)}
							</td>
							<td class="py-1.5 capitalize">{d.direction}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}
</DossierSubpageShell>

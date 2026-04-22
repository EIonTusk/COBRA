<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { buildFixFirst, type FixCategory } from '$lib/dossier/fixFirst';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(result ? buildFixFirst(result) : null);

	const CATEGORY_LABEL: Record<FixCategory, string> = {
		'tactical-motif': 'Tactical motif',
		'blunder-atlas': 'Blunder cluster',
		phase: 'Phase accuracy',
		'time-pressure': 'Time pressure'
	};

	function tint(rank: number) {
		if (rank === 1) return 'border-emerald-500/50 bg-emerald-950/15';
		if (rank <= 3) return 'border-[var(--color-brass-300)]/40 bg-[var(--color-ink-950)]';
		return 'border-[var(--color-ink-800)] bg-[var(--color-ink-950)]';
	}
</script>

<DossierSubpageShell
	title="Fix this first"
	subtitle="Prioritizes your leaks by (frequency × fixability × impact), so your next practice session has one concrete focus."
	{loaded}
	hasReport={!!result}
>
	{#if summary}
		{#if summary.candidates.length === 0}
			<div
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-4 text-sm text-[var(--color-parchment-400)]"
			>
				Not enough signal to rank leaks yet. Run a scan with engine analysis enabled.
			</div>
		{:else}
			<section class="mt-6 space-y-3">
				{#each summary.candidates as c (c.rank)}
					<div class="rounded border px-4 py-3 text-sm {tint(c.rank)}">
						<div class="flex flex-wrap items-baseline justify-between gap-2">
							<div>
								<span class="font-mono text-xs text-[var(--color-parchment-500)]">#{c.rank}</span>
								<span class="ml-2 text-[var(--color-parchment-100)]">{c.title}</span>
							</div>
							<!--
								Prior versions exposed an absolute `score` here. It was
								dimensionless (normalised combination of frequency and CP
								loss) and implied precision it doesn't have. The rank
								on the left is what users should read — the score is
								only meaningful for sorting.
							-->
							<div
								class="font-mono text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
							>
								{c.category}
							</div>
						</div>
						<div class="mt-1 text-xs text-[var(--color-parchment-500)]">
							{CATEGORY_LABEL[c.category]} · {c.frequency} occurrences · avg {c.avgCpLoss.toFixed(
								0
							)}cp
						</div>
						<p class="mt-2 text-xs text-[var(--color-parchment-300)]">{c.action}</p>
					</div>
				{/each}
			</section>
		{/if}
	{/if}
</DossierSubpageShell>

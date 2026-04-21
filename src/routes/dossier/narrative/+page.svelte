<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { buildNarrative } from '$lib/dossier/narrative';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const narrative = $derived(result ? buildNarrative(result) : null);
</script>

<DossierSubpageShell
	title="Narrative"
	subtitle="A plain-English player profile synthesised from every axis already computed for you. No new data — just a write-up."
	{loaded}
	hasReport={!!result}
>
	{#if narrative}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-5 py-5"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Headline</div>
			<p class="mt-2 font-serif text-2xl text-[var(--color-parchment-50)]">{narrative.headline}</p>
		</section>

		{#each narrative.paragraphs as p, idx (idx)}
			<section
				class="mt-4 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-5 py-5"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
					{p.heading}
				</div>
				<p class="mt-2 text-sm leading-relaxed text-[var(--color-parchment-200)]">{p.body}</p>
			</section>
		{/each}
	{/if}
</DossierSubpageShell>

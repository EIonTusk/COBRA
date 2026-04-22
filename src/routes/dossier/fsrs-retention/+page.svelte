<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { SvelteMap } from 'svelte/reactivity';
	import { buildFsrsFailures, LAPSE_THRESHOLD } from '$lib/dossier/fsrsFeedback';
	import type { FsrsFailureRow } from '$lib/dossier/fsrsFeedback';
	import { listRepertoires } from '$lib/storage/repertoires';
	import { listCards } from '$lib/storage/cards';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);
	let failures = $state<FsrsFailureRow[]>([]);

	onMount(async () => {
		const [saved, reps] = await Promise.all([loadDossierReport(), listRepertoires()]);
		if (saved?.payload) result = saved.payload as DossierScanResult;
		const allCards = (await Promise.all(reps.map((r) => listCards(r.id)))).flat();
		failures = buildFsrsFailures(allCards, reps, { limit: 100 });
		loaded = true;
	});

	const byRepertoire = $derived.by(() => {
		const map = new SvelteMap<string, { name: string; count: number; lapses: number }>();
		for (const f of failures) {
			const e = map.get(f.repertoireId) ?? { name: f.repertoireName, count: 0, lapses: 0 };
			e.count += 1;
			e.lapses += f.lapses;
			map.set(f.repertoireId, e);
		}
		return [...map.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.count - a.count);
	});
</script>

<DossierSubpageShell
	title="Knowledge retention"
	subtitle="Drill cards you have failed {LAPSE_THRESHOLD}+ times. These are positions you struggle to internalise even when isolated from in-game pressure — a different kind of leak from in-game blunders, flagged by the FSRS lapse counter."
	{loaded}
	hasReport={!!result}
>
	<section
		class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
	>
		<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Overall</div>
		<div class="mt-3 grid grid-cols-2 gap-3 text-xs">
			<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2">
				<div class="text-[var(--color-parchment-500)]">High-lapse cards</div>
				<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
					{failures.length}
				</div>
			</div>
			<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2">
				<div class="text-[var(--color-parchment-500)]">Total lapses in sample</div>
				<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
					{failures.reduce((s, f) => s + f.lapses, 0)}
				</div>
			</div>
		</div>
		{#if failures.length === 0}
			<p class="mt-3 text-xs text-[var(--color-parchment-500)]">
				No drill cards with {LAPSE_THRESHOLD}+ repeated failures yet — retention looks clean or the
				sample is thin.
			</p>
		{/if}
	</section>

	{#if byRepertoire.length > 0}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				By repertoire
			</div>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Repertoire</th>
						<th class="text-right">Cards</th>
						<th class="text-right">Total lapses</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each byRepertoire as r (r.id)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5 font-sans text-[var(--color-parchment-300)]">{r.name}</td>
							<td class="py-1.5 text-right">{r.count}</td>
							<td class="py-1.5 text-right">{r.lapses}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}

	{#if failures.length > 0}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Worst offenders
			</div>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				Sorted by lapse count. Drill these first.
			</p>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Expected</th>
						<th class="text-left">Repertoire</th>
						<th class="text-right">Lapses</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each failures as f (`${f.repertoireId}-${f.fenKey}`)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{f.expectedSan}</td>
							<td class="py-1.5 font-sans text-[var(--color-parchment-300)]">
								{f.repertoireName}
							</td>
							<td class="py-1.5 text-right text-amber-300">{f.lapses}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}
</DossierSubpageShell>

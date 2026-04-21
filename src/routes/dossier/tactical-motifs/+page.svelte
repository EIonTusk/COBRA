<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { Button } from '$lib/ui';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseTacticalMotifs, motifLabel, type Motif } from '$lib/dossier/tacticalMotifs';
	import { motifInstanceToStoredMistake } from '$lib/dossier/findingDrills';
	import { listRepertoires } from '$lib/storage/repertoires';
	import { saveMistakes } from '$lib/storage/mistakes';
	import type { DossierScanResult } from '$lib/dossier/scan';
	import type { Repertoire } from '$lib/types';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);
	let repertoires = $state<Repertoire[]>([]);
	let drillRepId = $state('');
	let saveStatus = $state<Record<string, string>>({});

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		repertoires = await listRepertoires();
		if (repertoires.length > 0) drillRepId = repertoires[0].id;
		loaded = true;
	});

	const summary = $derived(
		result ? analyseTacticalMotifs(result.evalAxes?.allMoves ?? null) : null
	);

	async function saveMotifDrills(motif: Motif) {
		if (!summary) return;
		const rep = repertoires.find((r) => r.id === drillRepId);
		if (!rep) {
			saveStatus = { ...saveStatus, [motif]: 'Pick a repertoire first.' };
			return;
		}
		const instances = summary.instances.filter((inst) => inst.motifs.includes(motif));
		if (instances.length === 0) {
			saveStatus = { ...saveStatus, [motif]: 'No samples to save.' };
			return;
		}
		const rows = instances
			.map((i) => motifInstanceToStoredMistake(i, motif, rep))
			.filter((m): m is NonNullable<typeof m> => m != null);
		const added = await saveMistakes(rows);
		saveStatus = {
			...saveStatus,
			[motif]: `Saved ${rows.length} (${added} new) to "${rep.name}".`
		};
	}

	function lichessUrl(fen: string) {
		return `https://lichess.org/analysis/standard/${encodeURIComponent(fen)}`;
	}
</script>

<DossierSubpageShell
	title="Tactical motifs"
	subtitle="Bucket of your blunders and mistakes by the tactical theme they missed. Heuristic — cheap geometry checks on the engine's best-move square, not full solution trees."
	{loaded}
	hasReport={!!result}
>
	{#if !result?.evalAxes}
		<div
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-4 text-sm"
		>
			This page needs an engine-analysed report. Run a scan with Stockfish on.
		</div>
	{:else if summary}
		{#if repertoires.length > 0}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-3 text-xs"
			>
				<label class="inline-flex items-center gap-2">
					<span class="text-[var(--color-parchment-400)]">Save drills to</span>
					<select
						bind:value={drillRepId}
						class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-2 py-1 text-[var(--color-parchment-100)]"
					>
						{#each repertoires as r (r.id)}
							<option value={r.id}>{r.name}</option>
						{/each}
					</select>
				</label>
			</section>
		{/if}

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">By motif</div>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				Analysed {summary.total} blunder/mistake moves. Each move can match multiple motifs.
			</p>
			<ul class="mt-3 grid gap-2">
				{#each summary.byMotif.filter((m) => m.motif !== 'unclassified') as m (m.motif)}
					<li
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2 text-xs"
					>
						<div class="flex flex-wrap items-baseline justify-between gap-2">
							<span class="text-[var(--color-parchment-100)]">{motifLabel(m.motif)}</span>
							<span class="font-mono text-[var(--color-parchment-400)]">
								{m.count} · avg {m.avgCpLoss.toFixed(0)}cp loss
							</span>
						</div>
						{#if m.samples.length > 0}
							<div class="mt-2 flex flex-wrap gap-1.5 text-[10px]">
								{#each m.samples as s (`${s.gameId}-${s.fenBefore}`)}
									<!-- eslint-disable svelte/no-navigation-without-resolve -->
									<a
										href={lichessUrl(s.fenBefore)}
										target="_blank"
										rel="noopener"
										class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-1.5 py-0.5 font-mono hover:border-[var(--color-brass-300)]/40"
									>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
										#{s.gameId.slice(0, 6)}
										{s.san}
									</a>
								{/each}
							</div>
						{/if}
						{#if repertoires.length > 0}
							<div class="mt-2 flex flex-wrap items-baseline gap-2">
								<Button onclick={() => saveMotifDrills(m.motif)}>Save as drills</Button>
								{#if saveStatus[m.motif]}
									<span class="text-[10px] text-emerald-300">{saveStatus[m.motif]}</span>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</DossierSubpageShell>

<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { Button } from '$lib/ui';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import {
		analyseRepeatOffenders,
		offenderHeading,
		type OffenderRow
	} from '$lib/dossier/repeatOffenders';
	import { motifLabel } from '$lib/dossier/tacticalMotifs';
	import { repeatFenToStoredMistake } from '$lib/dossier/findingDrills';
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
		result ? analyseRepeatOffenders(result.classified, result.evalAxes?.allMoves ?? null) : null
	);

	async function saveRowDrills(r: OffenderRow, rowKey: string) {
		const rep = repertoires.find((x) => x.id === drillRepId);
		if (!rep) {
			saveStatus = { ...saveStatus, [rowKey]: 'Pick a repertoire first.' };
			return;
		}
		const rows = r.exampleFens
			.map((fen, idx) => repeatFenToStoredMistake(r, fen, idx, rep))
			.filter((m): m is NonNullable<typeof m> => m != null);
		if (rows.length === 0) {
			saveStatus = { ...saveStatus, [rowKey]: 'No valid positions to save.' };
			return;
		}
		const added = await saveMistakes(rows);
		saveStatus = {
			...saveStatus,
			[rowKey]: `Saved ${rows.length} (${added} new) to "${rep.name}".`
		};
	}

	function rowKey(r: OffenderRow): string {
		return `${r.motif}:${r.pieceInvolved}`;
	}

	function lichessUrl(fen: string) {
		return `https://lichess.org/analysis/standard/${encodeURIComponent(fen)}`;
	}
</script>

<DossierSubpageShell
	title="Repeat offenders"
	subtitle="Tactical themes you blunder repeatedly, keyed by (motif, piece moving). Built on top of the tactical-motif labeller."
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
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Headline</div>
			<p class="mt-2 text-sm text-[var(--color-parchment-200)]">
				{#if summary.longestStreak && summary.longestStreak.length >= 2}
					Longest same-motif blunder streak: <span class="font-mono"
						>{summary.longestStreak.length}×</span
					>
					<span class="text-[var(--color-parchment-300)]"
						>{motifLabel(summary.longestStreak.motif)}</span
					>
					in a row.
				{:else}
					No multi-blunder same-motif streaks yet.
				{/if}
			</p>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				Across {summary.totalBlunders} categorised blunder/mistake moves.
			</p>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Top repeat offenders
			</div>
			<ul class="mt-3 grid gap-2">
				{#each summary.rows.slice(0, 15) as r, i (i)}
					{@const key = rowKey(r)}
					<li
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2 text-xs"
					>
						<div class="flex flex-wrap items-baseline justify-between gap-2">
							<span class="text-[var(--color-parchment-100)]">{offenderHeading(r)}</span>
							<span class="font-mono text-[var(--color-parchment-400)]">
								{r.count}× · {r.avgCpLoss.toFixed(0)}cp avg
							</span>
						</div>
						{#if r.exampleFens.length > 0}
							<div class="mt-2 flex flex-wrap gap-1.5 text-[10px]">
								{#each r.exampleFens as fen, idx (fen)}
									<!-- eslint-disable svelte/no-navigation-without-resolve -->
									<a
										href={lichessUrl(fen)}
										target="_blank"
										rel="noopener"
										class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-1.5 py-0.5 font-mono hover:border-[var(--color-brass-300)]/40"
									>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
										ex {idx + 1}
									</a>
								{/each}
							</div>
						{/if}
						{#if repertoires.length > 0 && r.exampleFens.length > 0}
							<div class="mt-2 flex flex-wrap items-baseline gap-2">
								<Button onclick={() => saveRowDrills(r, key)}>Save as drills</Button>
								{#if saveStatus[key]}
									<span class="text-[10px] text-emerald-300">{saveStatus[key]}</span>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</DossierSubpageShell>

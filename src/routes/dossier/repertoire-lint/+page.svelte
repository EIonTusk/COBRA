<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { buildRepertoireLint } from '$lib/dossier/repertoireLint';
	import { listRepertoires } from '$lib/storage/repertoires';
	import { listNodes } from '$lib/storage/nodes';
	import type { DossierScanResult } from '$lib/dossier/scan';
	import type { Repertoire, RepertoireNode } from '$lib/types';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);
	let repertoires = $state<Array<{ repertoire: Repertoire; nodes: RepertoireNode[] }>>([]);

	onMount(async () => {
		const [saved, reps] = await Promise.all([loadDossierReport(), listRepertoires()]);
		if (saved?.payload) result = saved.payload as DossierScanResult;
		repertoires = await Promise.all(
			reps.map(async (r) => ({ repertoire: r, nodes: await listNodes(r.id) }))
		);
		loaded = true;
	});

	const summary = $derived(
		result ? buildRepertoireLint(result.evalAxes?.allMoves ?? null, repertoires) : null
	);

	function lichessUrl(fen: string) {
		return `https://lichess.org/analysis/standard/${encodeURIComponent(fen)}`;
	}

	function classLabel(c: string) {
		return c.charAt(0).toUpperCase() + c.slice(1);
	}
</script>

<DossierSubpageShell
	title="Forgotten prep"
	subtitle="Positions that live in your repertoire trees where the game move differs from the prepared reply. High-leverage: the work was already done once; the leak is recall, not knowledge. Joined by exact FEN-key so transpositions resolve automatically."
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
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Overall</div>
			<div class="mt-3 grid grid-cols-3 gap-3 text-xs">
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Costly moves checked</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.checked}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Inside a repertoire</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.inRepertoire}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Deviated from prep</div>
					<div class="mt-1 font-mono text-lg text-amber-300">{summary.deviated}</div>
				</div>
			</div>
			{#if repertoires.length === 0}
				<p class="mt-3 text-xs text-[var(--color-parchment-500)]">
					No repertoires saved — there is nothing to cross-reference against.
				</p>
			{/if}
		</section>

		{#if summary.entries.length > 0}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
					Forgotten moves
				</div>
				<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
					Sorted by WP loss. Click a row to open the position in Lichess analysis.
				</p>
				<ul class="mt-2 grid gap-1">
					{#each summary.entries as e (`${e.gameId}-${e.ply}`)}
						<li>
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={lichessUrl(e.fenBefore)}
								target="_blank"
								rel="noopener"
								class="flex flex-wrap items-baseline justify-between gap-2 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-2 py-1 font-mono text-xs hover:border-[var(--color-brass-300)]/40"
							>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<span>
									#{e.gameId.slice(0, 6)} · ply {e.ply} · {e.phase}
									<span class="text-[var(--color-parchment-400)]"
										>· {classLabel(e.classification)}</span
									>
								</span>
								<span>
									<span class="text-amber-300">{e.userPlayedSan}</span>
									<span class="text-[var(--color-parchment-500)]"> vs prep </span>
									<span class="text-emerald-300">{e.preparedSan}</span>
									<span class="text-[var(--color-parchment-500)]">
										· {e.repertoireName} · −{e.cpLoss.toFixed(0)}cp
									</span>
								</span>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</DossierSubpageShell>

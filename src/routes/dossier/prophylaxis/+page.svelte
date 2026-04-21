<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseProphylaxis } from '$lib/dossier/prophylaxis';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(result ? analyseProphylaxis(result.evalAxes?.allMoves ?? null) : null);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}

	function lichessUrl(fen: string) {
		return `https://lichess.org/analysis/standard/${encodeURIComponent(fen)}`;
	}
</script>

<DossierSubpageShell
	title="Prophylaxis index"
	subtitle="How often you neutralize a genuine opponent threat. A &quot;threat&quot; is any opponent move (between two of yours) that shifted the eval toward them by ≥50 cp; you neutralize by bringing the eval back with your next move."
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
					<div class="text-[var(--color-parchment-500)]">Threats faced</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.opportunities}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Neutralized</div>
					<div class="mt-1 font-mono text-lg text-emerald-300">{summary.neutralized}</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Neutralize rate</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{pct(summary.neutralizeRate)}
					</div>
				</div>
			</div>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">By phase</div>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Phase</th>
						<th class="text-right">Threats</th>
						<th class="text-right">Neutralized</th>
						<th class="text-right">Compounded</th>
						<th class="text-right">Rate</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.byPhase as r (r.phase)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5 capitalize">{r.phase === 'end' ? 'Endgame' : r.phase}</td>
							<td class="py-1.5 text-right">{r.opportunities}</td>
							<td class="py-1.5 text-right text-emerald-300">{r.neutralized}</td>
							<td class="py-1.5 text-right text-amber-300">{r.compounded}</td>
							<td class="py-1.5 text-right">
								{r.opportunities > 0 ? pct(r.neutralized / r.opportunities) : '—'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		{#if summary.examples.length > 0}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
					Examples of big saves
				</div>
				<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
					Threats ≥100 cp that you neutralized. Click to open in Lichess analysis.
				</p>
				<ul class="mt-2 grid gap-1">
					{#each summary.examples as ex (`${ex.gameId}-${ex.ply}`)}
						<li>
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={lichessUrl(ex.fenBefore)}
								target="_blank"
								rel="noopener"
								class="flex items-baseline justify-between rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-2 py-1 font-mono text-xs hover:border-[var(--color-brass-300)]/40"
							>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<span>#{ex.gameId.slice(0, 6)} ply {ex.ply} · {ex.san}</span>
								<span class="text-[var(--color-parchment-400)]"
									>−{ex.delta.toFixed(0)}cp → held</span
								>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</DossierSubpageShell>

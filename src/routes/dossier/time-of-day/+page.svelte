<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseTimeOfDay, dayLabel } from '$lib/dossier/timeOfDay';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(
		result ? analyseTimeOfDay(result.classified, result.evalAxes?.allMoves ?? null) : null
	);

	const maxHourGames = $derived(summary ? Math.max(...summary.byHour.map((h) => h.games), 1) : 1);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}
</script>

<DossierSubpageShell
	title="Time of day / day of week"
	subtitle="When you play, and how you score. Hour and weekday are derived from each game's start timestamp in your local timezone."
	{loaded}
	hasReport={!!result}
>
	{#if summary}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Headline</div>
			<ul class="mt-2 space-y-1 text-sm text-[var(--color-parchment-200)]">
				{#if summary.bestHour != null && summary.worstHour != null}
					<li>
						Best hour: <span class="font-mono">{summary.bestHour}:00</span> · worst:
						<span class="font-mono">{summary.worstHour}:00</span>
					</li>
				{/if}
				{#if summary.bestDay != null && summary.worstDay != null}
					<li>
						Best day: <span class="font-mono">{dayLabel(summary.bestDay)}</span> · worst:
						<span class="font-mono">{dayLabel(summary.worstDay)}</span>
					</li>
				{/if}
			</ul>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				By hour (local tz)
			</div>
			<div class="mt-3 space-y-1 text-xs">
				{#each summary.byHour as h (h.hour)}
					<div class="flex items-center gap-2">
						<div class="w-10 font-mono text-[var(--color-parchment-400)]">
							{h.hour.toString().padStart(2, '0')}:00
						</div>
						<div class="h-2 flex-1 rounded bg-[var(--color-ink-950)]">
							<div
								class="h-full rounded {h.wins > h.losses ? 'bg-emerald-500/50' : 'bg-amber-500/50'}"
								style:width="{((h.games / maxHourGames) * 100).toFixed(1)}%"
							></div>
						</div>
						<div class="w-36 text-right font-mono">
							{h.games > 0 ? `${h.games}g · ${pct(h.winRate)}` : '—'}
							{#if h.avgCpLoss != null}
								· <span class="text-[var(--color-parchment-500)]">{h.avgCpLoss.toFixed(0)}cp</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">By weekday</div>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Day</th>
						<th class="text-right">Games</th>
						<th class="text-right">W/D/L</th>
						<th class="text-right">Win rate</th>
						<th class="text-right">Avg CP loss</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each summary.byDay as d (d.day)}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5">{dayLabel(d.day)}</td>
							<td class="py-1.5 text-right">{d.games}</td>
							<td class="py-1.5 text-right">{d.wins}/{d.draws}/{d.losses}</td>
							<td class="py-1.5 text-right">{d.games > 0 ? pct(d.winRate) : '—'}</td>
							<td class="py-1.5 text-right">{d.avgCpLoss != null ? d.avgCpLoss.toFixed(1) : '—'}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		{#if result}
			{@const fp = result.fingerprint}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
					Style axes by speed
				</div>
				<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
					Forcing + capture rate across the time controls in your sample. Useful for spotting
					whether you play the same chess in bullet as in rapid.
				</p>
				<table class="mt-3 w-full border-collapse text-sm">
					<thead class="text-left text-xs text-[var(--color-parchment-500)]">
						<tr>
							<th class="py-2 pr-4">Speed</th>
							<th class="py-2 pr-4">Games</th>
							<th class="py-2 pr-4">Forcing</th>
							<th class="py-2 pr-4">Capture</th>
						</tr>
					</thead>
					<tbody>
						{#each Object.entries(fp.bySpeed) as [speed, r] (speed)}
							<tr class="border-t border-[var(--color-ink-800)]">
								<td class="py-2 pr-4 font-medium">{speed}</td>
								<td class="py-2 pr-4 font-mono">{r.games}</td>
								<td class="py-2 pr-4 font-mono">{pct(r.forcing)}</td>
								<td class="py-2 pr-4 font-mono">{pct(r.capture)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		{/if}
	{/if}
</DossierSubpageShell>

<script lang="ts">
	import { resolve } from '$app/paths';
	import type { FixCandidate } from '$lib/dossier/fixFirst';

	interface Props {
		recommendations: FixCandidate[];
	}

	let { recommendations }: Props = $props();
</script>

<section id="section-7" class="mt-12 scroll-mt-6">
	<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">Section 7</div>
	<h2 class="mt-1 font-serif text-3xl text-[var(--color-parchment-50)]">Priority actions</h2>
	<p class="mt-4 max-w-3xl text-[15px] leading-relaxed text-[var(--color-parchment-300)]">
		{#if recommendations.length > 0}
			The items below are ranked by frequency × fixability × rating impact. Starting at R-01 and
			working down gives the fastest expected return on study time. Full rationale and
			drill-creation tools live on the
			<a class="text-[var(--color-brass-300)] hover:underline" href={resolve('/dossier/fix-first')}
				>Fix this first</a
			>
			page.
		{:else}
			Not enough signal to prioritise an action list yet. Scan more rated games, ideally with
			Stockfish enabled, and regenerate the report.
		{/if}
	</p>

	{#if recommendations.length > 0}
		<ol class="mt-6 divide-y divide-[var(--color-ink-800)] border-y border-[var(--color-ink-800)]">
			{#each recommendations as r (r.rank)}
				<li class="flex flex-col gap-2 py-5 sm:grid sm:grid-cols-[5rem_1fr] sm:gap-x-5 sm:gap-y-0">
					<div class="font-mono text-xs text-[var(--color-brass-300)]">
						R-{r.rank.toString().padStart(2, '0')}
					</div>
					<div>
						<h3 class="font-serif text-lg text-[var(--color-parchment-100)]">
							{r.title}
						</h3>
						<p class="mt-1 text-sm leading-relaxed text-[var(--color-parchment-300)]">
							{r.action}
						</p>
						<p class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
							{r.frequency} occurrences · avg {r.avgCpLoss.toFixed(0)}cp
						</p>
					</div>
				</li>
			{/each}
		</ol>
	{/if}
</section>

<script lang="ts">
	import type { StudyPlan, StudyPlanCategory } from '$lib/dossier/studyPlan';

	interface Props {
		plan: StudyPlan | null;
	}

	let { plan }: Props = $props();

	const CATEGORY_LABEL: Record<StudyPlanCategory, string> = {
		tactics: 'Tactics',
		opening: 'Opening',
		endgame: 'Endgame',
		time: 'Time use',
		positional: 'Positional'
	};

	const CATEGORY_ACCENT: Record<StudyPlanCategory, string> = {
		tactics: 'border-amber-300/40 text-amber-300',
		opening: 'border-[var(--color-brass-300)]/40 text-[var(--color-brass-300)]',
		endgame: 'border-emerald-500/40 text-emerald-300',
		time: 'border-sky-400/40 text-sky-300',
		positional: 'border-[var(--color-parchment-400)]/40 text-[var(--color-parchment-300)]'
	};
</script>

{#if plan && plan.items.length > 0}
	<section id="section-8" class="mt-12 scroll-mt-6">
		<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
			Section 8
		</div>
		<h2 class="mt-1 font-serif text-3xl text-[var(--color-parchment-50)]">
			Study plan for your bucket
		</h2>
		<p class="mt-4 max-w-3xl text-[15px] leading-relaxed text-[var(--color-parchment-300)]">
			Items below are framed against the {plan.hasBucket ? 'measured' : 'eyeballed'} peer baseline at
			<span class="font-mono text-[var(--color-parchment-100)]"
				>{plan.bucketLabel.toLowerCase()}</span
			>. Each one names the gap, the direction of the gap, and the data behind it. {#if !plan.hasBucket}
				Calibrate a peer baseline in Settings for tighter numbers.
			{/if}
		</p>

		<ol class="mt-6 divide-y divide-[var(--color-ink-800)] border-y border-[var(--color-ink-800)]">
			{#each plan.items as item (item.rank)}
				<li class="flex flex-col gap-2 py-5 sm:grid sm:grid-cols-[5rem_1fr] sm:gap-x-5 sm:gap-y-0">
					<div class="flex items-start gap-2 sm:block">
						<div class="font-mono text-xs text-[var(--color-brass-300)]">
							S-{item.rank.toString().padStart(2, '0')}
						</div>
						<div
							class="inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] tracking-wider uppercase sm:mt-1 {CATEGORY_ACCENT[
								item.category
							]}"
						>
							{CATEGORY_LABEL[item.category]}
						</div>
					</div>
					<div>
						<h3 class="font-serif text-lg text-[var(--color-parchment-100)]">
							{item.title}
						</h3>
						<p class="mt-1 text-sm leading-relaxed text-[var(--color-parchment-300)]">
							{item.rationale}
						</p>
						<p class="mt-1 text-sm leading-relaxed text-[var(--color-parchment-200)]">
							{item.action}
						</p>
						<p
							class="mt-2 font-mono text-[10px] tracking-wide text-[var(--color-parchment-500)] uppercase"
							title="Methodology — sample sizes and peer-baseline provenance"
						>
							{item.evidence}
						</p>
					</div>
				</li>
			{/each}
		</ol>
	</section>
{/if}

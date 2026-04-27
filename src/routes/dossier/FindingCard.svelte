<script lang="ts">
	import type { Snippet } from 'svelte';
	import { base } from '$app/paths';
	import { severityLabel, type InsightCard } from '$lib/dossier/deepInsights';
	import { severityDot, severityTint } from '$lib/dossier/format';

	interface Props {
		card: InsightCard;
		/** Section number (3..6). Drives the anchor and exhibit numbering. */
		sectionNum: number;
		/** 0-based index inside the section's cards array. */
		cardIdx: number;
		/** Section anchor prefix, e.g. `'section-3'`. The card's anchor becomes
		 *  `'section-3-1'` etc. */
		anchor: string;
		/** Caption for the figure block; pass null to skip rendering the figure. */
		exhibitCaption: string | null;
		/** Whether to render the "Open detail →" link at the bottom. */
		hasDetailRoute: boolean;
		/** Exhibit body — rendered inside the figure when exhibitCaption is set. */
		children?: Snippet;
	}

	let { card, sectionNum, cardIdx, anchor, exhibitCaption, hasDetailRoute, children }: Props =
		$props();

	function severityNarrative(s: InsightCard['severity']): string {
		switch (s) {
			case 'critical':
				return "this is the report's most urgent finding";
			case 'concern':
				return 'this is a concern worth addressing';
			case 'strength':
				return 'this is a strength to build around';
			case 'observation':
				return 'this is an observation, not a concern';
			default:
				return 'the sample was too small to rate this confidently';
		}
	}

	/**
	 * Render a card's methodology footnote as a single pre-joined string.
	 * Lives in the component to avoid a thicket of inline mustaches in the
	 * template.
	 */
	function formatMethodology(m: InsightCard['methodology']): string {
		if (!m) return '';
		const parts: string[] = [];
		if (m.n != null) {
			const label = m.denominator
				? `${m.n.toLocaleString()} ${m.denominator}`
				: m.n.toLocaleString();
			parts.push(`n = ${label}`);
		}
		if (m.engineDepth != null) parts.push(`Stockfish d${m.engineDepth}`);
		if (m.baselineN != null && m.baselineSource) {
			const bucket = m.baselineBucket ? ` (${m.baselineBucket})` : '';
			parts.push(`peer ${m.baselineSource}${bucket} n=${m.baselineN.toLocaleString()}`);
		}
		if (m.note) parts.push(m.note);
		return parts.join(' · ');
	}

	const showMethodology = $derived(
		card.methodology != null &&
			(card.methodology.n != null ||
				card.methodology.baselineN != null ||
				card.methodology.engineDepth != null)
	);
	const showSampleWarning = $derived(
		card.sampleSize != null && card.sampleMin != null && card.sampleSize < card.sampleMin
	);
</script>

<article
	id="{anchor}-{cardIdx + 1}"
	class="flex scroll-mt-6 flex-col gap-3 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-5 sm:grid sm:grid-cols-[5rem_1fr] sm:gap-x-5 sm:gap-y-0 sm:px-5"
	class:border-l-red-500={card.severity === 'critical'}
	class:border-l-amber-400={card.severity === 'concern'}
	class:border-l-emerald-500={card.severity === 'strength'}
	style="border-left-width: 3px;"
>
	<div class="flex flex-wrap items-center gap-2 text-xs sm:block">
		<div class="font-mono text-[var(--color-parchment-500)]">
			{sectionNum}.{cardIdx + 1}
		</div>
		<div
			class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] tracking-wider uppercase sm:mt-1 {severityTint(
				card.severity
			)}"
		>
			<span class="inline-block size-1.5 rounded-full {severityDot(card.severity)}"></span>
			{severityLabel(card.severity)}
		</div>
		{#if showSampleWarning}
			<div
				class="inline-flex items-center gap-1 rounded border border-amber-300/40 bg-amber-950/15 px-1.5 py-0.5 text-[9px] tracking-wider text-amber-300 uppercase sm:mt-1"
				title="Thin sample — finding auto-demoted to inconclusive"
			>
				⚠ {card.sampleSize}/{card.sampleMin}
			</div>
		{/if}
	</div>
	<div class="min-w-0">
		<h3 class="font-serif text-xl leading-snug text-[var(--color-parchment-100)]">
			{card.headline}
		</h3>
		<p class="mt-2 text-sm leading-relaxed text-[var(--color-parchment-300)]">
			<span class="text-[var(--color-parchment-200)]">{card.title}.</span>
			{severityNarrative(card.severity)}.
			{#if card.detail}
				<span class="text-[var(--color-parchment-400)]">{card.detail}</span>
			{/if}
		</p>

		{#if showMethodology}
			<p
				class="mt-2 font-mono text-[10px] tracking-wide text-[var(--color-parchment-500)] uppercase"
				title="Methodology — sample and peer-baseline provenance for this finding"
			>
				{formatMethodology(card.methodology)}
			</p>
		{/if}

		{#if exhibitCaption}
			<figure
				class="mt-4 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-4 py-3"
			>
				<figcaption
					class="flex items-baseline justify-between text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
				>
					<span>Exhibit {sectionNum}.{cardIdx + 1}</span>
					<span class="tracking-normal normal-case">
						{exhibitCaption}
					</span>
				</figcaption>

				<div class="mt-3 text-xs text-[var(--color-parchment-200)]">
					{@render children?.()}
				</div>
			</figure>
		{/if}

		{#if hasDetailRoute}
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a
				class="mt-3 inline-block text-xs text-[var(--color-brass-300)] hover:underline"
				href="{base}/dossier/{card.slug}"
			>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
				Open the {card.title.toLowerCase()} detail →
			</a>
		{/if}
	</div>
</article>

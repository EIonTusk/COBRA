<script lang="ts">
	import type { InsightCard } from '$lib/dossier/deepInsights';

	export interface PaperSection {
		num: number;
		anchor: string;
		title: string;
		intro: string;
		cards: InsightCard[];
	}

	interface Props {
		sections: PaperSection[];
	}

	let { sections }: Props = $props();
</script>

<nav
	class="mt-10 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-6 py-5 print:break-inside-avoid"
	aria-label="Contents"
>
	<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">Contents</div>
	<ol class="mt-3 grid gap-1 text-sm text-[var(--color-parchment-200)] sm:grid-cols-2">
		<li>
			<a class="hover:text-[var(--color-brass-300)]" href="#section-1">
				<span class="font-mono text-[var(--color-parchment-500)]">1.</span>
				Executive summary
			</a>
		</li>
		<li>
			<a class="hover:text-[var(--color-brass-300)]" href="#section-2">
				<span class="font-mono text-[var(--color-parchment-500)]">2.</span>
				Scope and methodology
			</a>
		</li>
		{#each sections as s (s.anchor)}
			<li>
				<a class="hover:text-[var(--color-brass-300)]" href="#{s.anchor}">
					<span class="font-mono text-[var(--color-parchment-500)]">{s.num}.</span>
					{s.title}
				</a>
				{#if s.cards.length > 0}
					<ol class="mt-1 ml-5 grid gap-0.5 text-xs text-[var(--color-parchment-400)]">
						{#each s.cards as c, cIdx (c.slug)}
							<li>
								<a class="hover:text-[var(--color-brass-300)]" href="#{s.anchor}-{cIdx + 1}">
									<span class="font-mono text-[var(--color-parchment-500)]">{s.num}.{cIdx + 1}</span
									>
									{c.title}
								</a>
							</li>
						{/each}
					</ol>
				{/if}
			</li>
		{/each}
		<li>
			<a class="hover:text-[var(--color-brass-300)]" href="#section-7">
				<span class="font-mono text-[var(--color-parchment-500)]">7.</span>
				Priority actions
			</a>
		</li>
		<li>
			<a class="hover:text-[var(--color-brass-300)]" href="#section-8">
				<span class="font-mono text-[var(--color-parchment-500)]">8.</span>
				Study plan for your bucket
			</a>
		</li>
		<li>
			<a class="hover:text-[var(--color-brass-300)]" href="#appendices">
				<span class="font-mono text-[var(--color-parchment-500)]">A.</span>
				Appendices (A–J)
			</a>
		</li>
	</ol>
</nav>

<script lang="ts">
	import type { BlunderAtlas, BlunderCluster } from '$lib/dossier/blunderAtlas';
	import { lichessAnalysisUrl } from '$lib/dossier/format';

	interface Props {
		atlas: BlunderAtlas | null;
		/** Repertoire id selected in the Drills card. When null, "Drill these"
		 *  is disabled and the explainer line shows. */
		drillRepId: string | null;
		/** Per-cluster status text to flash next to the title (e.g., "Saved 4 drills"). */
		statusByBucket: Record<string, string | undefined>;
		/** Save the cluster's items as drill mistakes for the selected repertoire. */
		onSaveAsDrills: (cluster: BlunderCluster) => void;
	}

	let { atlas, drillRepId, statusByBucket, onSaveAsDrills }: Props = $props();
</script>

{#if atlas && atlas.clusters.length > 0}
	<section
		class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
	>
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
				Appendix D
			</div>
			<h2 class="font-serif text-xl text-[var(--color-parchment-50)]">Blunder atlas</h2>
			<span class="text-xs text-[var(--color-parchment-500)]">
				{atlas.total} worst moves clustered by what went wrong.
			</span>
		</div>
		<div class="mt-4 space-y-2">
			{#each atlas.clusters as c (c.bucket)}
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="flex flex-wrap items-baseline justify-between gap-2">
						<div>
							<span class="font-serif text-lg text-[var(--color-parchment-100)]">{c.title}</span>
							<span class="ml-2 font-mono text-xs text-[var(--color-brass-300)]">{c.count}</span>
						</div>
						<button
							type="button"
							onclick={() => onSaveAsDrills(c)}
							disabled={!drillRepId || c.items.length === 0}
							class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-1 text-xs hover:border-[var(--color-brass-300)]/40 disabled:opacity-50"
						>
							Drill these
						</button>
					</div>
					<p class="mt-1 text-xs text-[var(--color-parchment-400)]">{c.summary}</p>
					<p class="mt-1 text-xs text-[var(--color-parchment-500)] italic">{c.drillHint}</p>
					{#if statusByBucket[c.bucket]}
						<p class="mt-1 text-xs text-emerald-400">{statusByBucket[c.bucket]}</p>
					{/if}
					{#if c.items.length > 0}
						<ul class="mt-2 space-y-1 font-mono text-xs text-[var(--color-parchment-400)]">
							{#each c.items.slice(0, 3) as it, i (i)}
								<li class="flex flex-wrap items-baseline justify-between gap-2">
									<span
										>ply {it.move.ply} ·
										<span class="text-[var(--color-parchment-200)]">{it.move.san}</span>
										· −{Math.round(it.move.cpLoss)} cp</span
									>
									<!-- eslint-disable svelte/no-navigation-without-resolve -->
									<a
										href={lichessAnalysisUrl(it.move.fenBefore)}
										target="_blank"
										rel="noopener"
										class="text-[var(--color-brass-300)] underline"
									>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
										Open
									</a>
								</li>
							{/each}
							{#if c.items.length > 3}
								<li class="text-[var(--color-parchment-500)]">+{c.items.length - 3} more</li>
							{/if}
						</ul>
					{/if}
				</div>
			{/each}
		</div>
		{#if !drillRepId}
			<p class="mt-3 text-xs text-[var(--color-parchment-500)]">
				Pick a repertoire further down (in the <em>Drills</em> card) to enable "Drill these".
			</p>
		{/if}
	</section>
{/if}

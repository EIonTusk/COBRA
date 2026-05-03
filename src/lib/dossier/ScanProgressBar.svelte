<script lang="ts">
	import { base, resolve } from '$app/paths';
	import { page } from '$app/state';
	import { X } from 'lucide-svelte';

	import { dossierScan } from './scanStore.svelte';

	// Percent fill: for the fetching phase we don't know the total game
	// count, so leave the bar indeterminate. For the analysing phase we
	// track done/total. When done, fill to 100.
	const fraction = $derived.by(() => {
		if (dossierScan.phase === 'analysing' && dossierScan.evalTotal > 0) {
			return Math.min(1, dossierScan.evalDone / dossierScan.evalTotal);
		}
		if (dossierScan.phase === 'done') return 1;
		return null;
	});

	const onDossierPage = $derived(page.url.pathname.slice(base.length).startsWith('/dossier'));
	const visible = $derived(dossierScan.running && !onDossierPage);
</script>

{#if visible}
	<div
		class="safe-pad-bottom fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-ink-700)] bg-[var(--color-ink-900)]/95 shadow-[0_-8px_24px_-8px_rgba(0,0,0,0.5)] backdrop-blur-md"
		role="status"
		aria-live="polite"
	>
		<div class="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-6 py-2.5">
			<div class="flex min-w-0 flex-1 items-center gap-3">
				<span
					class="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--color-brass-300)]"
					aria-hidden="true"
				></span>
				<div class="min-w-0 flex-1">
					<div class="flex min-w-0 items-baseline gap-2">
						<span class="eyebrow text-[var(--color-parchment-200)]">
							{#if dossierScan.phase === 'fetching'}
								Fetching games
							{:else if dossierScan.phase === 'analysing'}
								Analysing moves
							{:else}
								Dossier scan
							{/if}
						</span>
						{#if dossierScan.resumed}
							<span
								class="font-mono text-[10px] tracking-wider text-[var(--color-olive-300)] uppercase"
								title="Resumed from a saved checkpoint"
							>
								resumed
							</span>
						{/if}
						<span class="truncate font-mono text-[11px] text-[var(--color-parchment-500)]">
							{#if dossierScan.phase === 'fetching' && dossierScan.progressText}
								{dossierScan.progressText}
							{:else if dossierScan.phase === 'analysing' && dossierScan.evalTotal > 0}
								{dossierScan.evalDone} / {dossierScan.evalTotal} moves{#if dossierScan.evalAdopted > 0}
									· {dossierScan.evalAdopted} adopted from Lichess
								{/if}
							{:else if dossierScan.phase === 'fetching'}
								{dossierScan.scanGamesDone} games
							{/if}
						</span>
					</div>
					<div class="relative mt-1 h-px overflow-hidden bg-[var(--color-ink-800)]">
						{#if fraction != null}
							<div
								class="absolute inset-y-0 left-0 bg-[var(--color-brass-300)] transition-[width] duration-300"
								style:width="{fraction * 100}%"
							></div>
						{:else}
							<div
								class="absolute inset-y-0 -left-1/3 w-1/3 animate-[cobra-scan_1.6s_ease-in-out_infinite] bg-[var(--color-brass-300)]"
							></div>
						{/if}
					</div>
				</div>
			</div>
			<div class="flex shrink-0 items-center gap-2">
				<a
					href={resolve('/dossier')}
					class="eyebrow text-[var(--color-brass-300)] transition-colors hover:text-[var(--color-brass-200)]"
				>
					Open review →
				</a>
				<button
					type="button"
					onclick={() => dossierScan.cancel()}
					class="flex size-7 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-oxblood-300)]"
					aria-label="Cancel scan"
					title="Cancel scan"
				>
					<X class="size-3.5" />
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	@keyframes cobra-scan {
		0% {
			transform: translateX(0);
		}
		100% {
			transform: translateX(400%);
		}
	}
</style>

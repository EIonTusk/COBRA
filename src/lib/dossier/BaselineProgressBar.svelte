<script lang="ts">
	import { base, resolve } from '$app/paths';
	import { page } from '$app/state';
	import { X } from 'lucide-svelte';

	import { baselineCalibration } from './baselineCalibrationStore.svelte';
	import BaselineCalibrationProgress from './BaselineCalibrationProgress.svelte';

	// Hide the floating overlay on /settings — the same rich panel renders
	// inline inside the calibration card there, so showing both at once
	// would just stack two copies of the same progress display.
	const onSettingsPage = $derived(page.url.pathname.slice(base.length).startsWith('/settings'));
	const visible = $derived(baselineCalibration.running && !onSettingsPage);
</script>

{#if visible}
	<div
		class="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-ink-700)] bg-[var(--color-ink-900)]/95 shadow-[0_-8px_24px_-8px_rgba(0,0,0,0.5)] backdrop-blur-md"
		role="status"
		aria-live="polite"
	>
		<div class="mx-auto max-w-3xl px-6 py-3">
			<div class="mb-2 flex items-baseline justify-between gap-3">
				<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
					Baseline calibration
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<a
						href={resolve('/settings#dossier-baseline')}
						class="eyebrow text-[var(--color-brass-300)] transition-colors hover:text-[var(--color-brass-200)]"
					>
						Open settings →
					</a>
					<button
						type="button"
						onclick={() => baselineCalibration.cancel()}
						class="flex size-7 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-oxblood-300)]"
						aria-label="Cancel calibration"
						title="Cancel calibration"
					>
						<X class="size-3.5" />
					</button>
				</div>
			</div>
			<BaselineCalibrationProgress />
		</div>
	</div>
{/if}

<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { X } from 'lucide-svelte';

	import { listRepertoires } from '$lib/storage/repertoires';
	import { getSettings } from '$lib/storage/settings';
	import DrillRunner from '$lib/drill/DrillRunner.svelte';
	import { buildQuickDrillSegments } from '$lib/drill/quickDrill';
	import type { DrillSegment } from '$lib/drill/types';
	import type { AppSettings } from '$lib/types';

	let settings = $state<AppSettings | null>(null);
	let segments = $state<DrillSegment[] | null>(null);
	let runnerKey = $state(0);

	async function buildAllSegments(s: AppSettings): Promise<DrillSegment[]> {
		return buildQuickDrillSegments(await listRepertoires(), s);
	}

	onMount(async () => {
		settings = await getSettings();
		segments = await buildAllSegments(settings);
	});

	async function trainFurther() {
		if (!settings) return;
		segments = await buildAllSegments(settings);
		runnerKey++;
	}
</script>

<div class="mx-auto max-w-[1000px] px-4 py-4 md:px-6">
	<div class="mb-5 flex items-center gap-3">
		<span class="eyebrow text-[var(--color-parchment-300)]">Quick drill</span>
		<a
			href={resolve('/')}
			class="ml-auto flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)]"
			aria-label="Close drill"
		>
			<X class="size-4" />
		</a>
	</div>

	{#if !settings || !segments}
		<p class="text-sm text-[var(--color-parchment-400)]">Loading your due cards…</p>
	{:else}
		{#key runnerKey}
			<DrillRunner {segments} {settings} onTrainFurther={trainFurther} />
		{/key}
	{/if}
</div>

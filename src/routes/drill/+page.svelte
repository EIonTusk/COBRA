<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { X } from 'lucide-svelte';

	import { listRepertoires } from '$lib/storage/repertoires';
	import { getSettings } from '$lib/storage/settings';
	import DrillRunner from '$lib/drill/DrillRunner.svelte';
	import { buildSegment, segmentEventCount, segmentNewCount } from '$lib/drill/buildSegment';
	import type { DrillSegment } from '$lib/drill/types';
	import type { AppSettings } from '$lib/types';

	let settings = $state<AppSettings | null>(null);
	let segments = $state<DrillSegment[] | null>(null);
	let runnerKey = $state(0);

	/**
	 * Build a segment per repertoire. White reps come first, then black —
	 * keeps a session from ping-ponging between sides. The settings'
	 * `drillSessionCap` and `dailyNewCardCap` apply to the *merged* session
	 * (not per rep), so each segment is built against whatever budget the
	 * earlier segments left behind. Once the budget is exhausted, later
	 * reps drop out of the session entirely — they'll surface in a future
	 * drill once today's quota is spent.
	 */
	async function buildAllSegments(s: AppSettings): Promise<DrillSegment[]> {
		const reps = await listRepertoires();
		const colorRank = (c: 'white' | 'black') => (c === 'white' ? 0 : 1);
		const ordered = [...reps].sort((a, b) => colorRank(a.color) - colorRank(b.color));
		const out: DrillSegment[] = [];
		let remainingSession = s.drillSessionCap;
		let remainingNew = s.dailyNewCardCap;
		for (const rep of ordered) {
			if (remainingSession <= 0) break;
			const constrained: AppSettings = {
				...s,
				drillSessionCap: remainingSession,
				dailyNewCardCap: Math.max(0, remainingNew)
			};
			const seg = await buildSegment(rep, 'due', constrained);
			if (seg.cards.length === 0 && seg.ideaQueue.length === 0) continue;
			out.push(seg);
			remainingSession -= segmentEventCount(seg);
			remainingNew -= segmentNewCount(seg);
		}
		return out;
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

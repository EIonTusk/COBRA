<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { X } from 'lucide-svelte';

	import { getRepertoire } from '$lib/storage/repertoires';
	import { getSettings } from '$lib/storage/settings';
	import { resetAllFsrs } from '$lib/storage/cards';
	import { confirmDialog } from '$lib/ui';
	import DrillRunner from '$lib/drill/DrillRunner.svelte';
	import { buildSegment } from '$lib/drill/buildSegment';
	import type { DrillMode, DrillSegment } from '$lib/drill/types';
	import type { AppSettings, Repertoire } from '$lib/types';

	const mode = $derived<DrillMode>(
		page.url.searchParams.get('mode') === 'mistakes'
			? 'mistakes'
			: page.url.searchParams.get('mode') === 'retrain'
				? 'retrain'
				: 'due'
	);

	// Train-from-position: drill only the subtree rooted at this fenKey. Only
	// meaningful in `due` mode; mistakes/retrain ignore it.
	const fromKey = $derived(page.url.searchParams.get('from'));

	let rep = $state<Repertoire | null>(null);
	let settings = $state<AppSettings | null>(null);
	let segments = $state<DrillSegment[] | null>(null);
	let retrainBusy = $state(false);
	let loadFailed = $state(false);
	// Forces DrillRunner to fully remount on session reload — its internal
	// queue/state machine is keyed off the initial segments, so a fresh
	// session needs a fresh component instance.
	let runnerKey = $state(0);

	onMount(async () => {
		const id = page.params.id;
		if (!id) {
			loadFailed = true;
			return;
		}
		rep = (await getRepertoire(id)) ?? null;
		if (!rep) {
			loadFailed = true;
			return;
		}
		settings = await getSettings();
	});

	// Build segments whenever the mode or train-from-position anchor
	// (querystring) changes — mistakes → retrain → due each need a fresh queue,
	// and navigating in from a new position must rebuild the scoped queue. The
	// page is reused across these via in-place navigation.
	let lastBuiltKey: string | null = null;
	$effect(() => {
		const m = mode;
		const from = fromKey;
		if (!rep || !settings) return;
		const key = `${m}|${from ?? ''}`;
		if (lastBuiltKey === key) return;
		lastBuiltKey = key;
		void (async () => {
			if (!rep || !settings) return;
			segments = [await buildSegment(rep, m, settings, { startFenKey: from })];
			runnerKey++;
		})();
	});

	async function trainFurther() {
		if (!rep || !settings) return;
		segments = [await buildSegment(rep, mode, settings, { startFenKey: fromKey })];
		runnerKey++;
	}

	async function retrain() {
		if (!rep || !settings || retrainBusy) return;
		const ok = await confirmDialog({
			title: 'Retrain from scratch',
			message:
				'Reset spaced-repetition state for every card in this repertoire. Positions stay; the schedule restarts from zero and everything becomes due immediately.',
			confirmLabel: 'Reset schedule',
			variant: 'destructive'
		});
		if (!ok) return;
		retrainBusy = true;
		try {
			await resetAllFsrs(rep.id);
			segments = [await buildSegment(rep, mode, settings, { startFenKey: fromKey })];
			runnerKey++;
		} finally {
			retrainBusy = false;
		}
	}
</script>

<div class="mx-auto max-w-[1000px] px-4 py-4 md:px-6">
	<div class="mb-5 flex items-center gap-3">
		<span class="eyebrow text-[var(--color-parchment-300)]">Drill</span>
		{#if rep}
			<span class="text-[var(--color-ink-600)]">·</span>
			<a
				href={resolve(`/repertoire/${rep.id}`)}
				class="eyebrow max-w-[280px] truncate transition-colors hover:text-[var(--color-parchment-100)]"
			>
				{rep.name}
			</a>
		{/if}
		{#if fromKey}
			<span class="text-[var(--color-ink-600)]">·</span>
			<span class="eyebrow text-[var(--color-parchment-400)]">from this position</span>
		{/if}
		<a
			href={rep ? resolve(`/repertoire/${rep.id}`) : resolve('/')}
			class="ml-auto flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)]"
			aria-label="Close drill"
		>
			<X class="size-4" />
		</a>
	</div>

	{#if loadFailed}
		<div class="ink-panel mt-8 flex flex-col items-center gap-3 px-8 py-16 text-center">
			<p class="font-serif text-sm text-[var(--color-parchment-400)] italic">
				Repertoire not found.
			</p>
			<a class="eyebrow underline" href={resolve('/library')}>Back to library</a>
		</div>
	{:else if !rep || !settings || !segments}
		<p class="text-sm text-[var(--color-parchment-400)]">Loading due cards…</p>
	{:else}
		{#key runnerKey}
			<DrillRunner
				{segments}
				{settings}
				onTrainFurther={trainFurther}
				onRetrain={retrain}
				{retrainBusy}
			/>
		{/key}
	{/if}
</div>

<script lang="ts">
	import { onMount } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { Check, Download } from 'lucide-svelte';

	import { decodeShare, importShareBundle, type ShareBundle } from '$lib/storage/share';
	import { Button, DashboardBacklink } from '$lib/ui';

	let bundle = $state<ShareBundle | null>(null);
	let error = $state<string | null>(null);
	let importing = $state(false);

	onMount(async () => {
		const hash = typeof window !== 'undefined' ? window.location.hash : '';
		if (!hash) {
			error = 'No share payload — paste a full share link into the address bar.';
			return;
		}
		const params = new URLSearchParams(hash.replace(/^#/, ''));
		const data = params.get('data');
		if (!data) {
			error = 'Share link is missing the `#data=…` fragment.';
			return;
		}
		try {
			bundle = await decodeShare(data);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not decode the share link.';
		}
	});

	async function onImport() {
		if (!bundle) return;
		importing = true;
		try {
			const rep = await importShareBundle(bundle);
			await goto(resolve(`/repertoire/${rep.id}`));
		} catch (e) {
			error = e instanceof Error ? e.message : 'Import failed.';
			importing = false;
		}
	}
</script>

<div class="relative mx-auto max-w-2xl px-6 pt-14 pb-16">
	<DashboardBacklink />

	<div class="eyebrow mb-3">Shared repertoire</div>
	<h1 class="font-serif text-5xl leading-[1.05] tracking-tight">
		Import <em class="text-[var(--color-brass-300)]">someone else's</em> prep.
	</h1>

	{#if error}
		<p class="mt-6 text-sm text-[var(--color-oxblood-300)]">{error}</p>
	{:else if !bundle}
		<p class="mt-6 font-serif text-sm text-[var(--color-parchment-400)] italic">
			Decoding share link…
		</p>
	{:else}
		<div class="ink-panel mt-8 p-4">
			<div class="eyebrow mb-2">You're about to import</div>
			<h2 class="font-serif text-2xl">{bundle.repertoire.name}</h2>
			<p class="mt-1 font-serif text-sm text-[var(--color-parchment-400)] italic">
				Side: <strong class="text-[var(--color-brass-300)] not-italic">
					{bundle.repertoire.color}
				</strong>
			</p>
			<div class="mt-4 grid grid-cols-3 gap-2 font-mono text-[12px] tabular-nums">
				<div class="ink-panel p-2">
					<div class="eyebrow">Positions</div>
					<div class="mt-1 text-xl">{bundle.nodes.length}</div>
				</div>
				<div class="ink-panel p-2">
					<div class="eyebrow">Move cards</div>
					<div class="mt-1 text-xl">{bundle.cards.length}</div>
				</div>
				<div class="ink-panel p-2">
					<div class="eyebrow">Idea cards</div>
					<div class="mt-1 text-xl">{bundle.ideaCards.length}</div>
				</div>
			</div>
			<p class="mt-4 font-serif text-xs text-[var(--color-parchment-500)] italic">
				Imported as a brand new repertoire under a fresh id — won't touch any existing ones. Card
				schedules reset to "due now" so you start learning this prep fresh.
			</p>
			<div class="mt-4 flex items-center gap-2">
				<Button variant="primary" size="md" onclick={onImport} disabled={importing}>
					{#if importing}
						<Check class="size-3.5" />
						<span>Importing…</span>
					{:else}
						<Download class="size-3.5" />
						<span>Import repertoire</span>
					{/if}
				</Button>
				<Button href={`${base}/library`} variant="outline" size="md">Cancel</Button>
			</div>
		</div>
	{/if}
</div>

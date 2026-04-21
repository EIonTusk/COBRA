<script lang="ts">
	import { resolve } from '$app/paths';
	import { ArrowLeft } from 'lucide-svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		subtitle?: string;
		loaded: boolean;
		hasReport: boolean;
		children: Snippet;
	}

	let { title, subtitle, loaded, hasReport, children }: Props = $props();
</script>

<div class="mx-auto max-w-5xl px-4 py-8 sm:px-6">
	<a
		href={resolve('/dossier')}
		class="inline-flex items-center gap-1.5 text-sm text-[var(--color-parchment-400)] hover:text-[var(--color-parchment-100)]"
	>
		<ArrowLeft class="size-4" />
		Style Fingerprint
	</a>

	<h1 class="mt-3 font-serif text-3xl text-[var(--color-parchment-50)]">{title}</h1>
	{#if subtitle}
		<p class="mt-2 max-w-2xl text-sm text-[var(--color-parchment-400)]">{subtitle}</p>
	{/if}

	{#if !loaded}
		<div
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-4 text-sm text-[var(--color-parchment-400)]"
		>
			Loading saved report…
		</div>
	{:else if !hasReport}
		<div class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-4">
			<p class="text-sm text-[var(--color-parchment-200)]">No saved report yet.</p>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				This page reads from the most recent Style scan. Run a scan on the
				<a class="underline" href={resolve('/dossier')}>main report</a> first.
			</p>
		</div>
	{:else}
		{@render children()}
	{/if}
</div>

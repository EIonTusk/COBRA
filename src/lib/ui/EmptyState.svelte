<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from './utils';

	interface Props {
		class?: string;
		title: string;
		description?: string;
		ornament?: string;
		actions?: Snippet;
	}

	let { class: className, title, description, ornament = '⁂', actions }: Props = $props();
</script>

<div
	class={cn(
		'ink-panel flex flex-col items-center gap-3 px-8 py-12 text-center',
		'border-dashed border-[var(--color-ink-700)]',
		className
	)}
>
	<div class="ornament mb-1 font-serif text-3xl">{ornament}</div>
	<h3 class="font-serif text-2xl text-[var(--color-parchment-100)]">{title}</h3>
	{#if description}
		<p class="max-w-sm text-sm text-[var(--color-parchment-400)]">{description}</p>
	{/if}
	{#if actions}
		<div class="mt-2 flex gap-2">{@render actions()}</div>
	{/if}
</div>

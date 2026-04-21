<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from './utils';

	interface Props {
		class?: string;
		children: Snippet;
		padding?: 'none' | 'sm' | 'md' | 'lg';
		as?: 'div' | 'section' | 'article' | 'aside';
	}

	let { class: className, children, padding = 'md', as = 'div' }: Props = $props();

	const pad = $derived({ none: '', sm: 'p-3', md: 'p-4', lg: 'p-6' }[padding]);
</script>

<svelte:element this={as} class={cn('ink-panel', pad, className)}>
	{@render children()}
</svelte:element>

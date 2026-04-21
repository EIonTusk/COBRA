<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { cn } from './utils';

	type Props = Omit<HTMLInputAttributes, 'class'> & {
		class?: string;
		value?: string | number;
	};

	let { class: className, value = $bindable(), type = 'text', ...rest }: Props = $props();
</script>

<input
	{type}
	bind:value
	class={cn(
		'h-10 w-full rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-3',
		'font-sans text-sm text-[var(--color-parchment-100)] placeholder:text-[var(--color-parchment-400)]',
		'transition-colors duration-150',
		'hover:border-[var(--color-ink-600)]',
		'focus:border-[var(--color-brass-300)] focus:ring-[3px] focus:ring-[var(--color-brass-300)]/15 focus:outline-none',
		className
	)}
	{...rest}
/>

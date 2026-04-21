<script lang="ts">
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import { cn } from './utils';

	type Props = Omit<HTMLTextareaAttributes, 'class'> & {
		class?: string;
		value?: string;
	};

	let { class: className, value = $bindable(), ...rest }: Props = $props();
</script>

<textarea
	bind:value
	class={cn(
		'w-full rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-3 py-2',
		'font-sans text-sm text-[var(--color-parchment-100)] placeholder:text-[var(--color-parchment-400)]',
		'resize-y transition-colors duration-150',
		'hover:border-[var(--color-ink-600)]',
		'focus:border-[var(--color-brass-300)] focus:ring-[3px] focus:ring-[var(--color-brass-300)]/15 focus:outline-none',
		className
	)}
	{...rest}
></textarea>

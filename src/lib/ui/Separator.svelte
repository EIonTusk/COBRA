<script lang="ts">
	import { cn } from './utils';

	interface Props {
		orientation?: 'horizontal' | 'vertical';
		class?: string;
	}

	let { orientation = 'horizontal', class: className }: Props = $props();
</script>

<div
	role="separator"
	aria-orientation={orientation}
	class={cn(
		orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px self-stretch',
		'bg-[var(--color-ink-700)]',
		className
	)}
></div>

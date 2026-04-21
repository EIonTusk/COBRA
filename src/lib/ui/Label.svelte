<script lang="ts">
	import type { HTMLLabelAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';
	import { cn } from './utils';

	type Props = Omit<HTMLLabelAttributes, 'class' | 'children' | 'for'> & {
		class?: string;
		children: Snippet;
		for?: string;
	};

	let { class: className, children, for: htmlFor, ...rest }: Props = $props();
</script>

<label for={htmlFor} class={cn('eyebrow mb-1.5 block', className)} {...rest}>
	{@render children()}
</label>

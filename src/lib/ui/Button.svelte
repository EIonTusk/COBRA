<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	export const buttonVariants = tv({
		base: [
			'inline-flex items-center justify-center gap-2 whitespace-nowrap',
			'font-sans tracking-tight',
			'transition-[background,border,color,transform] duration-150',
			'disabled:opacity-40 disabled:pointer-events-none',
			'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brass-300)]',
			'active:translate-y-px'
		],
		variants: {
			variant: {
				primary: [
					'bg-[var(--color-brass-300)] text-[var(--color-ink-950)] font-medium',
					'hover:bg-[var(--color-brass-200)]',
					'shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_1px_2px_rgba(0,0,0,0.35)]'
				].join(' '),
				secondary: [
					'bg-[var(--color-ink-800)] text-[var(--color-parchment-100)]',
					'border border-[var(--color-ink-700)]',
					'hover:bg-[var(--color-ink-700)] hover:border-[var(--color-ink-600)]'
				].join(' '),
				ghost:
					'bg-transparent text-[var(--color-parchment-200)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)]',
				outline: [
					'bg-transparent text-[var(--color-parchment-100)]',
					'border border-[var(--color-ink-700)]',
					'hover:bg-[var(--color-ink-850)] hover:border-[var(--color-ink-600)]'
				].join(' '),
				destructive: [
					'bg-transparent text-[var(--color-oxblood-300)]',
					'border border-[var(--color-oxblood-400)]/40',
					'hover:bg-[var(--color-oxblood-500)]/30 hover:border-[var(--color-oxblood-300)]/60'
				].join(' '),
				link: 'bg-transparent text-[var(--color-brass-300)] hover:text-[var(--color-brass-200)] underline underline-offset-4 decoration-[var(--color-brass-300)]/40 hover:decoration-[var(--color-brass-200)] px-0 h-auto'
			},
			size: {
				xs: 'h-7 px-2.5 text-xs rounded-[3px]',
				sm: 'h-8 px-3 text-xs rounded-[3px]',
				md: 'h-9 px-4 text-[13px] rounded-[4px]',
				lg: 'h-11 px-6 text-sm rounded-[5px]',
				icon: 'size-9 p-0 rounded-[4px]'
			}
		},
		defaultVariants: { variant: 'primary', size: 'md' }
	});

	export type ButtonVariants = VariantProps<typeof buttonVariants>;
</script>

<script lang="ts">
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';
	import { cn } from './utils';

	type Props = {
		variant?: ButtonVariants['variant'];
		size?: ButtonVariants['size'];
		class?: string;
		children?: Snippet;
		href?: string;
	} & Omit<HTMLButtonAttributes & HTMLAnchorAttributes, 'class' | 'children'>;

	let {
		variant = 'primary',
		size = 'md',
		class: className,
		children,
		href,
		type = 'button',
		...rest
	}: Props = $props();
</script>

{#if href}
	<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
	<a {href} class={cn(buttonVariants({ variant, size }), className)} {...rest}>
		{@render children?.()}
	</a>
{:else}
	<button {type} class={cn(buttonVariants({ variant, size }), className)} {...rest}>
		{@render children?.()}
	</button>
{/if}

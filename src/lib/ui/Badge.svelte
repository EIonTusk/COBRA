<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	export const badgeVariants = tv({
		base: 'inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.18em] px-2 py-0.5 rounded-full border font-sans',
		variants: {
			variant: {
				default:
					'bg-[var(--color-ink-800)] text-[var(--color-parchment-300)] border-[var(--color-ink-700)]',
				brass:
					'bg-[var(--color-brass-500)]/15 text-[var(--color-brass-200)] border-[var(--color-brass-400)]/35',
				olive:
					'bg-[var(--color-olive-500)]/25 text-[var(--color-olive-300)] border-[var(--color-olive-400)]/40',
				oxblood:
					'bg-[var(--color-oxblood-500)]/25 text-[var(--color-oxblood-300)] border-[var(--color-oxblood-400)]/40',
				copper:
					'bg-[var(--color-copper-500)]/25 text-[var(--color-copper-300)] border-[var(--color-copper-400)]/40',
				muted: 'bg-transparent text-[var(--color-parchment-400)] border-[var(--color-ink-700)]'
			}
		},
		defaultVariants: { variant: 'default' }
	});
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from './utils';

	interface Props {
		variant?: VariantProps<typeof badgeVariants>['variant'];
		class?: string;
		children: Snippet;
	}

	let { variant = 'default', class: className, children }: Props = $props();
</script>

<span class={cn(badgeVariants({ variant }), className)}>
	{@render children()}
</span>

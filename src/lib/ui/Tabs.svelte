<script lang="ts" module>
	export interface TabDef {
		id: string;
		label: string;
	}
</script>

<script lang="ts">
	import { cn } from './utils';

	interface Props {
		tabs: TabDef[];
		value: string;
		onchange: (id: string) => void;
		class?: string;
	}

	let { tabs, value, onchange, class: className }: Props = $props();
</script>

<div
	role="tablist"
	class={cn('flex items-center gap-4 border-b border-[var(--color-ink-800)] px-1', className)}
>
	{#each tabs as tab (tab.id)}
		{@const active = tab.id === value}
		<button
			type="button"
			role="tab"
			aria-selected={active}
			class="eyebrow relative flex h-10 items-center transition-colors hover:text-[var(--color-parchment-100)]"
			class:!text-[var(--color-parchment-50)]={active}
			onclick={() => onchange(tab.id)}
		>
			{tab.label}
			{#if active}
				<span class="absolute inset-x-0 -bottom-px h-[2px] bg-[var(--color-brass-300)]"></span>
			{/if}
		</button>
	{/each}
</div>

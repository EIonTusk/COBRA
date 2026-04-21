<script lang="ts" generics="V extends string | number | null">
	import { Check, ChevronDown } from 'lucide-svelte';
	import { cn } from './utils';

	type Option = { value: V; label: string };

	type Props = {
		options: Option[];
		value: V;
		onchange: (next: V) => void;
		placeholder?: string;
		class?: string;
		id?: string;
	};

	let { options, value, onchange, placeholder = 'Select…', class: className, id }: Props = $props();

	let open = $state(false);
	let root = $state<HTMLDivElement | null>(null);

	function pick(v: V) {
		onchange(v);
		open = false;
	}

	function onDocMouseDown(e: MouseEvent) {
		if (!open || !root) return;
		if (e.target instanceof Node && root.contains(e.target)) return;
		open = false;
	}

	function onDocKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			open = false;
		}
	}

	const currentLabel = $derived.by(() => {
		const match = options.find((o) => o.value === value);
		return match?.label ?? '';
	});
</script>

<svelte:window onmousedown={onDocMouseDown} onkeydown={onDocKeydown} />

<div class={cn('relative', className)} bind:this={root}>
	<button
		{id}
		type="button"
		aria-haspopup="listbox"
		aria-expanded={open}
		onclick={() => (open = !open)}
		class={cn(
			'flex h-10 w-full items-center gap-2 rounded-[4px] border px-3 text-left font-mono text-[13px] transition-colors',
			'border-[var(--color-ink-700)] bg-[var(--color-ink-900)] text-[var(--color-parchment-100)]',
			'hover:border-[var(--color-ink-600)]',
			'focus:border-[var(--color-brass-300)] focus:ring-[3px] focus:ring-[var(--color-brass-300)]/15 focus:outline-none',
			open && 'border-[var(--color-brass-300)] ring-[3px] ring-[var(--color-brass-300)]/15'
		)}
	>
		<span
			class={cn('min-w-0 flex-1 truncate', !currentLabel && 'text-[var(--color-parchment-400)]')}
		>
			{currentLabel || placeholder}
		</span>
		<ChevronDown
			class={cn(
				'size-4 shrink-0 text-[var(--color-parchment-400)] transition-transform',
				open && 'rotate-180'
			)}
		/>
	</button>

	{#if open}
		<div
			role="listbox"
			class="absolute z-40 mt-1 w-full overflow-hidden rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] shadow-[0_16px_32px_-8px_rgba(0,0,0,0.8)]"
		>
			<ul class="max-h-64 overflow-y-auto py-1">
				{#each options as opt (String(opt.value))}
					{@const active = opt.value === value}
					<li>
						<button
							type="button"
							role="option"
							aria-selected={active}
							onclick={() => pick(opt.value)}
							class={cn(
								'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-[13px] transition-colors',
								active ? 'text-[var(--color-brass-300)]' : 'text-[var(--color-parchment-200)]',
								'hover:bg-[var(--color-ink-800)]'
							)}
						>
							<span class="truncate">{opt.label}</span>
							{#if active}
								<Check class="size-3.5 shrink-0" strokeWidth={2.5} />
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>

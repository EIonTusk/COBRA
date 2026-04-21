<script lang="ts" generics="V extends string | number">
	import { SvelteSet } from 'svelte/reactivity';
	import type { Snippet } from 'svelte';
	import { Check, ChevronDown } from 'lucide-svelte';
	import { cn } from './utils';

	type Option = { value: V; label: string };

	type Props = {
		options: Option[];
		selected: V[];
		onchange: (next: V[]) => void;
		placeholder?: string;
		class?: string;
		id?: string;
		renderOption?: Snippet<[Option]>;
		renderSummary?: Snippet<[Option[]]>;
	};

	let {
		options,
		selected,
		onchange,
		placeholder = 'Select…',
		class: className,
		id,
		renderOption,
		renderSummary
	}: Props = $props();

	const selectedOptions = $derived(options.filter((o) => selected.includes(o.value)));

	let open = $state(false);
	let root = $state<HTMLDivElement | null>(null);

	function toggle(v: V) {
		const set = new SvelteSet(selected);
		if (set.has(v)) set.delete(v);
		else set.add(v);
		// Preserve the source ordering so the saved list stays canonical.
		onchange(options.filter((o) => set.has(o.value)).map((o) => o.value));
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

	const summary = $derived.by(() => {
		if (selected.length === 0) return '';
		const picked = options.filter((o) => selected.includes(o.value)).map((o) => o.label);
		return picked.join(', ');
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
			'flex h-10 w-full items-center gap-2 rounded-[4px] border px-3 text-left font-sans text-sm transition-colors',
			'border-[var(--color-ink-700)] bg-[var(--color-ink-900)] text-[var(--color-parchment-100)]',
			'hover:border-[var(--color-ink-600)]',
			'focus:border-[var(--color-brass-300)] focus:ring-[3px] focus:ring-[var(--color-brass-300)]/15 focus:outline-none',
			open && 'border-[var(--color-brass-300)] ring-[3px] ring-[var(--color-brass-300)]/15'
		)}
	>
		<span
			class={cn(
				'flex min-w-0 flex-1 items-center gap-1.5',
				selected.length === 0 && 'text-[var(--color-parchment-400)]'
			)}
		>
			{#if selected.length === 0}
				<span class="truncate">{placeholder}</span>
			{:else if renderSummary}
				{@render renderSummary(selectedOptions)}
			{:else}
				<span class="truncate">{summary}</span>
			{/if}
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
			aria-multiselectable="true"
			class={cn(
				'absolute z-20 mt-1 w-full overflow-hidden rounded-[4px] border',
				'border-[var(--color-ink-700)] bg-[var(--color-ink-900)] shadow-[0_8px_24px_-8px_rgba(0,0,0,0.6)]'
			)}
		>
			<ul class="max-h-64 overflow-y-auto py-1">
				{#each options as opt (opt.value)}
					{@const active = selected.includes(opt.value)}
					<li>
						<button
							type="button"
							role="option"
							aria-selected={active}
							onclick={() => toggle(opt.value)}
							class={cn(
								'flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[13px] transition-colors',
								active ? 'text-[var(--color-brass-300)]' : 'text-[var(--color-parchment-200)]',
								'hover:bg-[var(--color-ink-850)]'
							)}
						>
							<span
								class={cn(
									'flex size-4 shrink-0 items-center justify-center rounded-[2px] border',
									active
										? 'border-[var(--color-brass-300)] bg-[var(--color-brass-300)]'
										: 'border-[var(--color-ink-600)]'
								)}
							>
								{#if active}
									<Check class="size-3 text-[var(--color-ink-950)]" strokeWidth={3} />
								{/if}
							</span>
							{#if renderOption}
								{@render renderOption(opt)}
							{:else}
								<span class="truncate">{opt.label}</span>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>

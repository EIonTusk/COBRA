<script lang="ts">
	import { MultiSelect, SourceIcon } from '$lib/ui';
	import type { ScanAccount } from '$lib/types';

	export interface AccountOption {
		value: string;
		label: string;
		account: ScanAccount;
	}

	interface Props {
		options: AccountOption[];
		/** Two-way bound — empty array means "every configured account". */
		selected: string[];
		onSelect: (next: string[]) => void;
		/** Lookup from option value to the source/username pair. */
		byValue: Map<string, ScanAccount>;
		placeholder?: string;
		/** Override width / sizing of the underlying MultiSelect trigger. */
		class?: string;
		id?: string;
	}

	let {
		options,
		selected,
		onSelect,
		byValue,
		placeholder = 'All',
		class: cls = '',
		id
	}: Props = $props();
</script>

<MultiSelect {options} {selected} onchange={onSelect} {placeholder} class={cls} {id}>
	{#snippet renderOption(opt)}
		{@const account = byValue.get(opt.value)}
		{#if account}
			<span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
				<SourceIcon source={account.source} />
			</span>
			<span class="truncate">{account.username}</span>
		{:else}
			<span class="truncate">{opt.label}</span>
		{/if}
	{/snippet}
	{#snippet renderSummary(chosen)}
		<span class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
			{#each chosen as opt (opt.value)}
				{@const account = byValue.get(opt.value)}
				{#if account}
					<span
						class="inline-flex items-center gap-1 rounded-[3px] bg-[var(--color-ink-850)] px-1 py-0.5 font-mono text-[11px]"
					>
						<span class="flex h-3 w-3 items-center justify-center">
							<SourceIcon source={account.source} />
						</span>
						<span class="truncate">{account.username}</span>
					</span>
				{/if}
			{/each}
		</span>
	{/snippet}
</MultiSelect>

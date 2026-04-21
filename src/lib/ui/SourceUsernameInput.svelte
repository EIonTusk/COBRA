<script lang="ts" module>
	export type Source = 'lichess' | 'chesscom';
</script>

<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import Input from './Input.svelte';
	import SourceIcon from './SourceIcon.svelte';
	import { cn } from './utils';

	type Props = Omit<HTMLInputAttributes, 'class' | 'value' | 'placeholder'> & {
		class?: string;
		source: Source;
		username: string;
		placeholderLichess?: string;
		placeholderChesscom?: string;
	};

	let {
		class: className,
		source = $bindable(),
		username = $bindable(),
		placeholderLichess = 'DrNykterstein',
		placeholderChesscom = 'hikaru',
		disabled,
		...rest
	}: Props = $props();
</script>

<div class={cn('relative', className)}>
	<div
		class="absolute top-1/2 left-1 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-[3px] border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] p-0.5"
		role="radiogroup"
		aria-label="Account source"
	>
		<button
			type="button"
			role="radio"
			aria-checked={source === 'lichess'}
			aria-label="Lichess"
			title="Lichess"
			{disabled}
			onclick={() => (source = 'lichess')}
			class={cn(
				'flex h-6 w-6 items-center justify-center rounded-[2px] transition-colors',
				source === 'lichess'
					? 'bg-[var(--color-ink-800)] text-[var(--color-brass-300)]'
					: 'text-neutral-500 grayscale hover:text-neutral-300',
				disabled && 'cursor-not-allowed opacity-50'
			)}
		>
			<SourceIcon source="lichess" />
		</button>
		<button
			type="button"
			role="radio"
			aria-checked={source === 'chesscom'}
			aria-label="chess.com"
			title="chess.com"
			{disabled}
			onclick={() => (source = 'chesscom')}
			class={cn(
				'flex h-6 w-6 items-center justify-center rounded-[2px] transition-colors',
				source === 'chesscom'
					? 'bg-[var(--color-ink-800)] text-[var(--color-olive-300)]'
					: 'text-neutral-500 grayscale hover:text-neutral-300',
				disabled && 'cursor-not-allowed opacity-50'
			)}
		>
			<SourceIcon source="chesscom" />
		</button>
	</div>
	<Input
		bind:value={username}
		{disabled}
		placeholder={source === 'chesscom' ? placeholderChesscom : placeholderLichess}
		class="pl-[4.25rem] font-mono"
		{...rest}
	/>
</div>

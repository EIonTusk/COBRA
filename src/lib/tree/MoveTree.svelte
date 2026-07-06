<script lang="ts">
	import { Shuffle, ChevronDown, ChevronRight } from 'lucide-svelte';
	import type { TreeRow } from './treeView';

	interface Props {
		rows: TreeRow[];
		/** Position currently shown on the board — its move is highlighted. */
		currentFenKey: string;
		/** True when the repertoire root has White to move (move numbering). */
		rootWhiteToMove: boolean;
		/** Jump the board to the position after this move. */
		onJump: (fenKey: string) => void;
		/** Fold/unfold the subtree below the position after this move. */
		onToggleCollapse: (fenKey: string) => void;
		/**
		 * Height sizing for the scroll container. Defaults to a capped panel; a
		 * flex-fill (`flex-1 min-h-0`) lets it grow inside a full-height drawer.
		 */
		heightClass?: string;
	}

	let {
		rows,
		currentFenKey,
		rootWhiteToMove,
		onJump,
		onToggleCollapse,
		heightClass = 'max-h-[420px]'
	}: Props = $props();

	// Move numbering relative to the root. For a Black-to-move root the first
	// ply is a Black move, so shift the parity by one.
	function isWhiteMove(ply: number): boolean {
		return rootWhiteToMove ? ply % 2 === 1 : ply % 2 === 0;
	}
	function moveNumber(ply: number): number {
		const eff = rootWhiteToMove ? ply : ply + 1;
		return Math.ceil(eff / 2);
	}
	// Number prefix: always before a White move; before a Black move only when
	// it opens a row (so a mid-row Black reply stays bare, as in PGN).
	function prefix(ply: number, first: boolean): string | null {
		if (isWhiteMove(ply)) return `${moveNumber(ply)}.`;
		if (first) return `${moveNumber(ply)}…`;
		return null;
	}

	// Auto-scroll the highlighted move into view when the board navigates.
	let scroller = $state<HTMLElement | null>(null);
	$effect(() => {
		// Re-run whenever the current position changes.
		void currentFenKey;
		if (!scroller) return;
		const el = scroller.querySelector<HTMLElement>('[data-current="true"]');
		if (el) el.scrollIntoView({ block: 'nearest' });
	});
</script>

<div
	bind:this={scroller}
	class="{heightClass} overflow-y-auto rounded-[3px] border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-2 py-2 font-mono text-[13px] leading-6"
>
	{#if rows.length === 0}
		<p class="px-1 py-1 font-serif text-sm text-[var(--color-parchment-500)] italic">
			No moves yet. Play a move on the board to start building.
		</p>
	{:else}
		{#each rows as row (row.id)}
			<div
				class="tree-row flex flex-wrap items-baseline gap-x-1.5"
				style:padding-left="{row.depth * 0.9}rem"
				class:border-l={row.depth > 0}
				class:border-l-transparent={row.depth === 0}
			>
				{#each row.moves as move, i (move.fenKey + ':' + i)}
					{@const pfx = prefix(move.ply, i === 0)}
					{#if pfx}
						<span class="text-[var(--color-parchment-600)] tabular-nums">{pfx}</span>
					{/if}
					<button
						type="button"
						data-current={move.fenKey === currentFenKey}
						onclick={() => onJump(move.fenKey)}
						title={move.disabled
							? 'Disabled — excluded from drilling'
							: move.transposition
								? `${move.san} — transposes into a line shown elsewhere`
								: undefined}
						class="inline-flex items-center gap-1 rounded-[2px] px-1 text-[var(--color-parchment-100)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-brass-300)]"
						class:!bg-[var(--color-brass-500)]={move.fenKey === currentFenKey}
						class:!text-[var(--color-ink-950)]={move.fenKey === currentFenKey}
						class:line-through={move.disabled}
						class:opacity-50={move.disabled}
					>
						{move.san}
						{#if move.transposition}
							<Shuffle class="size-3 opacity-70" strokeWidth={1.75} />
						{/if}
					</button>
					{#if move.foldable || move.collapsed}
						<button
							type="button"
							onclick={(e) => {
								e.stopPropagation();
								onToggleCollapse(move.fenKey);
							}}
							title={move.collapsed
								? `Expand ${move.hiddenCount} hidden move${move.hiddenCount === 1 ? '' : 's'}`
								: 'Collapse this line'}
							aria-label={move.collapsed ? 'Expand line' : 'Collapse line'}
							class="fold-toggle inline-flex items-center gap-0.5 rounded-[2px] px-0.5 text-[var(--color-parchment-500)] transition-colors hover:text-[var(--color-brass-300)]"
							class:is-collapsed={move.collapsed}
						>
							{#if move.collapsed}
								<ChevronRight class="size-3" strokeWidth={2.25} />
								<span class="text-[10px] tabular-nums">{move.hiddenCount}</span>
							{:else}
								<ChevronDown class="size-3" strokeWidth={2.25} />
							{/if}
						</button>
					{/if}
				{/each}
			</div>
		{/each}
	{/if}
</div>

<style>
	/* Fold controls stay quiet until you hover the line, so branch points
	   don't clutter the outline. A collapsed line keeps its brass count visible. */
	.fold-toggle {
		opacity: 0.4;
	}
	.tree-row:hover .fold-toggle {
		opacity: 0.85;
	}
	.fold-toggle:hover {
		opacity: 1;
	}
	.fold-toggle.is-collapsed {
		opacity: 1;
		color: var(--color-brass-300);
	}
</style>

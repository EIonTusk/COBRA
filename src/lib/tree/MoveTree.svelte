<script lang="ts">
	import { Shuffle, ChevronDown, ChevronRight, CircleSlash, GraduationCap } from 'lucide-svelte';
	import { Button } from '$lib/ui';
	import type { TreeMove, TreeRow } from './treeView';

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
		/**
		 * Right-click actions on a move (issue #96). Each is optional; the menu
		 * shows only the ones provided, and doesn't open when none are.
		 * `onRemove` is called after the user confirms.
		 */
		onRemove?: (move: TreeMove) => void;
		onToggleDisabled?: (move: TreeMove, next: boolean) => void;
		onTrain?: (move: TreeMove) => void;
		/** Moves saved beneath a position, shown in the remove confirmation. */
		countBelow?: (fenKey: string) => number;
	}

	let {
		rows,
		currentFenKey,
		rootWhiteToMove,
		onJump,
		onToggleCollapse,
		heightClass = 'max-h-[420px]',
		onRemove,
		onToggleDisabled,
		onTrain,
		countBelow
	}: Props = $props();

	// Right-click menu, fixed-positioned at the cursor.
	let menuMove = $state<TreeMove | null>(null);
	let menuX = $state(0);
	let menuY = $state(0);
	function openMenu(e: MouseEvent, move: TreeMove) {
		if (!onRemove && !onToggleDisabled && !onTrain) return;
		e.preventDefault();
		menuMove = move;
		// Keep the menu on screen when opened near the right or bottom edge.
		menuX = Math.max(8, Math.min(e.clientX, window.innerWidth - 200));
		menuY = Math.max(8, Math.min(e.clientY, window.innerHeight - 140));
	}
	function closeMenu() {
		menuMove = null;
	}
	function trainFromMenu() {
		if (menuMove) onTrain?.(menuMove);
		closeMenu();
	}
	function toggleFromMenu() {
		if (menuMove) onToggleDisabled?.(menuMove, !menuMove.edgeDisabled);
		closeMenu();
	}

	// Remove goes through a confirm that shows how much sits beneath the move.
	let confirmMove = $state<TreeMove | null>(null);
	let confirmCount = $state(0);
	function confirmFromMenu() {
		if (!menuMove) return;
		confirmMove = menuMove;
		confirmCount = countBelow?.(menuMove.fenKey) ?? 0;
		closeMenu();
	}
	function closeConfirm() {
		confirmMove = null;
		confirmCount = 0;
	}
	function commitConfirm() {
		if (confirmMove) onRemove?.(confirmMove);
		closeConfirm();
	}

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
						oncontextmenu={(e) => openMenu(e, move)}
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

{#if menuMove}
	<div
		role="presentation"
		class="fixed inset-0 z-50"
		onclick={closeMenu}
		oncontextmenu={(e) => {
			e.preventDefault();
			closeMenu();
		}}
	></div>
	<div
		role="menu"
		tabindex="-1"
		onkeydown={(e) => {
			if (e.key === 'Escape') closeMenu();
		}}
		class="ink-panel fixed z-50 flex min-w-[11rem] flex-col overflow-hidden rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] shadow-lg"
		style:left="{menuX}px"
		style:top="{menuY}px"
	>
		<div
			class="border-b border-[var(--color-ink-800)] px-3 py-1.5 font-mono text-[11px] text-[var(--color-parchment-500)]"
		>
			{menuMove.san}
		</div>
		{#if onTrain}
			<button
				type="button"
				role="menuitem"
				onclick={trainFromMenu}
				class="flex items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)]"
			>
				<GraduationCap
					class="size-3.5 shrink-0 text-[var(--color-parchment-400)]"
					strokeWidth={1.75}
				/>
				Train from here
			</button>
		{/if}
		{#if onToggleDisabled}
			<button
				type="button"
				role="menuitem"
				onclick={toggleFromMenu}
				class="flex items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)]"
			>
				<CircleSlash class="size-3.5 shrink-0 text-[var(--color-parchment-400)]" strokeWidth={2} />
				{menuMove.edgeDisabled ? 'Enable line' : 'Disable line'}
			</button>
		{/if}
		{#if onRemove}
			<button
				type="button"
				role="menuitem"
				onclick={confirmFromMenu}
				class="flex items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--color-oxblood-300)] transition-colors hover:bg-[var(--color-ink-800)]"
			>
				Remove move…
			</button>
		{/if}
	</div>
{/if}

{#if confirmMove}
	<div
		role="presentation"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
		onclick={(e) => {
			if (e.target === e.currentTarget) closeConfirm();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') closeConfirm();
		}}
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="tree-confirm-remove-title"
			class="ink-panel w-full max-w-sm rounded-[6px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-5 shadow-lg"
		>
			<h3 id="tree-confirm-remove-title" class="eyebrow mb-2 text-[var(--color-parchment-200)]">
				Remove from tree
			</h3>
			<p class="mb-4 font-serif text-sm text-[var(--color-parchment-300)]">
				{#if confirmCount === 0}
					Remove <span class="font-mono text-[var(--color-parchment-100)]">{confirmMove.san}</span>
					from your tree?
				{:else}
					Remove <span class="font-mono text-[var(--color-parchment-100)]">{confirmMove.san}</span>
					and the {confirmCount}
					{confirmCount === 1 ? 'move' : 'moves'} you've prepared beneath it?
				{/if}
			</p>
			<div class="flex justify-end gap-2">
				<Button variant="secondary" size="sm" onclick={closeConfirm}>Cancel</Button>
				<Button variant="destructive" size="sm" onclick={commitConfirm}>Remove</Button>
			</div>
		</div>
	</div>
{/if}

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

<script lang="ts">
	import { Button, DatePicker, Label, Select } from '$lib/ui';
	import DossierAccountSelector from './DossierAccountSelector.svelte';
	import type { AccountOption } from './DossierAccountSelector.svelte';
	import type { ScanAccount } from '$lib/types';

	/**
	 * Two presentation modes:
	 *
	 *   - `compact` — used inside the "Report on file" panel as a re-scan
	 *     trigger. Shorter widths; depth labels carry wall-clock estimates
	 *     ("14 · fast (~2 min)") because the user already has data and is
	 *     deciding whether the time investment is worth it.
	 *   - `fresh` — used when no report exists yet. Wider account selector,
	 *     proper Label component for the accounts field, depth labels
	 *     without the time hints (the user is exploring, not deciding).
	 */
	export type ScanControlsMode = 'compact' | 'fresh';

	interface Props {
		mode: ScanControlsMode;
		accountOptions: AccountOption[];
		selectedAccountKeys: string[];
		accountByValue: Map<string, ScanAccount>;
		maxGames: number;
		evalDepth: number;
		/** Global since-date in ms-epoch from AppSettings, or undefined for
		 *  "no cutoff". The control reads from and writes back to this value
		 *  via `onGamesSinceChange` — edits here propagate to settings so
		 *  every other scan picks up the same cutoff. */
		gamesSince: number | undefined;
		running: boolean;
		onSelectAccounts: (next: string[]) => void;
		onMaxGamesChange: (next: number) => void;
		onDepthChange: (next: number) => void;
		onGamesSinceChange: (next: number | undefined) => void;
		onRun: () => void;
		/** Optional secondary action — "Cancel" while running, "Discard" when on file. */
		onSecondary?: () => void;
		/** Label for the primary button. */
		primaryLabel: string;
		/** Label for the optional secondary button; omit to hide it. */
		secondaryLabel?: string;
	}

	let {
		mode,
		accountOptions,
		selectedAccountKeys,
		accountByValue,
		maxGames,
		evalDepth,
		gamesSince,
		running,
		onSelectAccounts,
		onMaxGamesChange,
		onDepthChange,
		onGamesSinceChange,
		onRun,
		onSecondary,
		primaryLabel,
		secondaryLabel
	}: Props = $props();

	const depthOptions = $derived(
		mode === 'compact'
			? [
					{ value: 14, label: '14 · fast (~2 min)' },
					{ value: 18, label: '18 · balanced (~8 min)' },
					{ value: 22, label: '22 · deep (~30 min)' }
				]
			: [
					{ value: 14, label: '14 · fast' },
					{ value: 18, label: '18 · balanced' },
					{ value: 22, label: '22 · deep' }
				]
	);
</script>

{#if mode === 'compact'}
	<div class="flex flex-wrap items-center gap-3 text-xs">
		<label class="inline-flex items-center gap-2">
			<span class="text-[var(--color-parchment-400)]">Accounts</span>
			<DossierAccountSelector
				options={accountOptions}
				selected={selectedAccountKeys}
				onSelect={onSelectAccounts}
				byValue={accountByValue}
				placeholder="All"
				class="w-56"
			/>
		</label>
		<label class="inline-flex items-center gap-2">
			<span class="text-[var(--color-parchment-400)]">Games/account</span>
			<input
				type="number"
				value={maxGames}
				oninput={(e) => onMaxGamesChange(Number((e.currentTarget as HTMLInputElement).value))}
				min="10"
				max="500"
				class="h-10 w-24 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-3 font-sans text-sm text-[var(--color-parchment-100)] transition-colors hover:border-[var(--color-ink-600)] focus:border-[var(--color-brass-300)] focus:ring-[3px] focus:ring-[var(--color-brass-300)]/15 focus:outline-none"
			/>
		</label>
		<label class="inline-flex items-center gap-2">
			<span
				class="text-[var(--color-parchment-400)]"
				title="Skip games played before this date. Empty = scan as far back as the per-account cap allows. Saved globally — applies to mistakes and other scans too."
				>Since</span
			>
			<DatePicker value={gamesSince} onchange={onGamesSinceChange} class="w-44" />
		</label>
		<label class="inline-flex items-center gap-2">
			<span
				class="text-[var(--color-parchment-400)]"
				title="Higher depth = sharper tactics but slower scan. Leak re-eval always runs at depth 20 regardless."
				>Engine depth</span
			>
			<Select
				value={evalDepth}
				onchange={(v) => {
					if (v != null) onDepthChange(v);
				}}
				options={depthOptions}
				class="w-52"
			/>
		</label>
	</div>
	<div class="flex flex-wrap items-center gap-3 text-xs">
		<Button onclick={onRun}>{primaryLabel}</Button>
		{#if onSecondary && secondaryLabel}
			<button
				type="button"
				onclick={onSecondary}
				class="text-[var(--color-parchment-400)] underline"
			>
				{secondaryLabel}
			</button>
		{/if}
	</div>
{:else}
	<div class="mt-6 flex flex-wrap items-end gap-3">
		<div class="min-w-[14rem] flex-1">
			<Label for="dossier-accounts">
				<span
					class="cursor-help underline decoration-[var(--color-parchment-500)]/60 decoration-dotted underline-offset-2"
					title="Leave empty to scan every configured account"
				>
					Accounts
				</span>
			</Label>
			<DossierAccountSelector
				id="dossier-accounts"
				options={accountOptions}
				selected={selectedAccountKeys}
				onSelect={onSelectAccounts}
				byValue={accountByValue}
				placeholder="All accounts"
			/>
		</div>
		<label class="flex flex-col gap-1 text-sm">
			<span
				class="cursor-help text-[var(--color-parchment-400)] underline decoration-[var(--color-parchment-500)]/60 decoration-dotted underline-offset-2"
				title="Per account"
			>
				Games
			</span>
			<input
				type="number"
				value={maxGames}
				oninput={(e) => onMaxGamesChange(Number((e.currentTarget as HTMLInputElement).value))}
				min="10"
				max="500"
				class="h-10 w-20 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-3 font-sans text-sm text-[var(--color-parchment-100)] transition-colors hover:border-[var(--color-ink-600)] focus:border-[var(--color-brass-300)] focus:ring-[3px] focus:ring-[var(--color-brass-300)]/15 focus:outline-none"
			/>
		</label>
		<label class="flex flex-col gap-1 text-sm">
			<span
				class="cursor-help text-[var(--color-parchment-400)] underline decoration-[var(--color-parchment-500)]/60 decoration-dotted underline-offset-2"
				title="Skip games played before this date. Empty = scan as far back as the per-account cap allows. Saved globally — applies to mistakes and other scans too."
			>
				Since
			</span>
			<DatePicker value={gamesSince} onchange={onGamesSinceChange} class="w-44" />
		</label>
		<label class="flex flex-col gap-1 text-sm">
			<span
				class="text-[var(--color-parchment-400)]"
				title="Higher depth = sharper tactics but slower scan. Leak re-eval always runs at depth 20 regardless."
				>Engine depth</span
			>
			<Select
				value={evalDepth}
				onchange={(v) => {
					if (v != null) onDepthChange(v);
				}}
				options={depthOptions}
				class="w-40"
			/>
		</label>
		<div class="flex items-center gap-3 self-end">
			<Button onclick={onRun} disabled={running}>
				{running ? 'Scanning…' : primaryLabel}
			</Button>
			{#if running && onSecondary && secondaryLabel}
				<button
					type="button"
					onclick={onSecondary}
					class="text-xs text-[var(--color-parchment-400)] underline"
				>
					{secondaryLabel}
				</button>
			{/if}
		</div>
	</div>
{/if}

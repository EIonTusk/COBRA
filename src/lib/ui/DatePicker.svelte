<script lang="ts">
	import { DatePicker as DatePickerPrimitive } from 'bits-ui';
	import { CalendarDate, type DateValue, getLocalTimeZone, today } from '@internationalized/date';
	import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, X } from 'lucide-svelte';

	import { cn } from './utils';

	interface Props {
		/** Selected date as ms since epoch, or undefined for "no date". */
		value: number | undefined;
		onchange: (next: number | undefined) => void;
		/** Optional latest selectable date as ms-epoch. Defaults to today. */
		maxValue?: number;
		/** Optional earliest selectable date as ms-epoch. */
		minValue?: number;
		/** Allow clearing the selection back to undefined. Defaults to true. */
		clearable?: boolean;
		disabled?: boolean;
		/**
		 * BCP-47 locale tag. Drives segment order in the typeable input
		 * (e.g. en-GB → dd/mm/yyyy, en-US → mm/dd/yyyy) and the calendar's
		 * weekday/month names. Defaults to the browser's UI locale.
		 */
		locale?: string;
		id?: string;
		class?: string;
	}

	let {
		value,
		onchange,
		maxValue,
		minValue,
		clearable = true,
		disabled = false,
		locale,
		id,
		class: className
	}: Props = $props();

	let open = $state(false);

	/**
	 * Convert a ms-epoch into a `CalendarDate` interpreted in the user's
	 * local timezone. bits-ui speaks `DateValue`; we keep the external API
	 * in ms-epoch so consumers don't need to take a runtime dep on
	 * `@internationalized/date`.
	 */
	function msToCalendarDate(ms: number | undefined): CalendarDate | undefined {
		if (ms == null || !Number.isFinite(ms)) return undefined;
		const d = new Date(ms);
		return new CalendarDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
	}

	function calendarDateToMs(d: DateValue | undefined): number | undefined {
		if (!d) return undefined;
		return d.toDate(getLocalTimeZone()).getTime();
	}

	const selected = $derived(msToCalendarDate(value));
	const max = $derived(msToCalendarDate(maxValue) ?? today(getLocalTimeZone()));
	const min = $derived(msToCalendarDate(minValue));
	// Anchor the calendar's view on the current value, otherwise on the
	// max bound (today by default), so opening an empty picker doesn't
	// strand the user on year zero.
	const placeholderDate = $derived(selected ?? max);

	function handleValueChange(next: DateValue | undefined) {
		onchange(calendarDateToMs(next));
	}

	function handleClear(e: MouseEvent) {
		// The clear chip lives inside the input shell. Stop the click from
		// bubbling so the parent label / popover doesn't react.
		e.stopPropagation();
		e.preventDefault();
		onchange(undefined);
	}
</script>

<DatePickerPrimitive.Root
	value={selected}
	onValueChange={handleValueChange}
	placeholder={placeholderDate}
	maxValue={max}
	minValue={min}
	{disabled}
	{locale}
	bind:open
	weekdayFormat="short"
>
	<!-- Typeable input shell. The user can click any segment and type
	     digits / use arrows to advance day, month, year. The calendar
	     trigger sits on the right and opens the popover for mouse use. -->
	<DatePickerPrimitive.Input
		{id}
		class={cn(
			'flex h-10 w-full items-center gap-1 rounded-[4px] border px-3 font-mono text-[13px] transition-colors',
			'border-[var(--color-ink-700)] bg-[var(--color-ink-900)] text-[var(--color-parchment-100)]',
			'hover:border-[var(--color-ink-600)]',
			'focus-within:border-[var(--color-brass-300)] focus-within:ring-[3px] focus-within:ring-[var(--color-brass-300)]/15',
			disabled && 'cursor-not-allowed opacity-50',
			className
		)}
	>
		{#snippet children({ segments })}
			<div class="flex min-w-0 flex-1 items-center">
				{#each segments as { part, value: segValue }, idx (idx)}
					{#if part === 'literal'}
						<DatePickerPrimitive.Segment {part} class="px-0.5 text-[var(--color-parchment-500)]">
							{segValue}
						</DatePickerPrimitive.Segment>
					{:else}
						<DatePickerPrimitive.Segment
							{part}
							class={cn(
								'rounded-[2px] px-1 tabular-nums transition-colors',
								'hover:bg-[var(--color-ink-800)]',
								'focus:bg-[var(--color-brass-300)] focus:text-[var(--color-ink-950)] focus:outline-none',
								'data-[placeholder]:text-[var(--color-parchment-500)]',
								'aria-[invalid=true]:text-[var(--color-oxblood-300)]'
							)}
						>
							{segValue}
						</DatePickerPrimitive.Segment>
					{/if}
				{/each}
			</div>
			{#if clearable && value != null && !disabled}
				<button
					type="button"
					aria-label="Clear date"
					onclick={handleClear}
					class="grid size-5 shrink-0 place-items-center rounded text-[var(--color-parchment-500)] transition-colors hover:text-[var(--color-oxblood-300)]"
				>
					<X class="size-3.5" />
				</button>
			{/if}
			<DatePickerPrimitive.Trigger
				aria-label="Open calendar"
				class="grid size-6 shrink-0 place-items-center rounded text-[var(--color-parchment-400)] transition-colors hover:text-[var(--color-parchment-100)] focus:text-[var(--color-parchment-100)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
			>
				<CalendarIcon class="size-4" />
			</DatePickerPrimitive.Trigger>
		{/snippet}
	</DatePickerPrimitive.Input>

	<DatePickerPrimitive.Content
		sideOffset={6}
		class="z-50 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] p-3 shadow-[0_16px_32px_-8px_rgba(0,0,0,0.8)] outline-none"
	>
		<DatePickerPrimitive.Calendar class="font-mono text-[13px] text-[var(--color-parchment-100)]">
			{#snippet children({ months, weekdays })}
				<DatePickerPrimitive.Header class="mb-3 flex items-center justify-between gap-2">
					<DatePickerPrimitive.PrevButton
						class="grid size-7 place-items-center rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] text-[var(--color-parchment-300)] transition-colors hover:border-[var(--color-ink-600)] hover:text-[var(--color-parchment-100)] disabled:cursor-not-allowed disabled:opacity-40"
					>
						<ChevronLeft class="size-3.5" />
					</DatePickerPrimitive.PrevButton>
					<DatePickerPrimitive.Heading
						class="font-serif text-sm text-[var(--color-parchment-100)]"
					/>
					<DatePickerPrimitive.NextButton
						class="grid size-7 place-items-center rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] text-[var(--color-parchment-300)] transition-colors hover:border-[var(--color-ink-600)] hover:text-[var(--color-parchment-100)] disabled:cursor-not-allowed disabled:opacity-40"
					>
						<ChevronRight class="size-3.5" />
					</DatePickerPrimitive.NextButton>
				</DatePickerPrimitive.Header>

				{#each months as month (month.value)}
					<DatePickerPrimitive.Grid class="w-full border-collapse">
						<DatePickerPrimitive.GridHead>
							<DatePickerPrimitive.GridRow class="flex">
								{#each weekdays as wd (wd)}
									<DatePickerPrimitive.HeadCell
										class="grid size-8 place-items-center text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
									>
										{wd.slice(0, 2)}
									</DatePickerPrimitive.HeadCell>
								{/each}
							</DatePickerPrimitive.GridRow>
						</DatePickerPrimitive.GridHead>
						<DatePickerPrimitive.GridBody>
							{#each month.weeks as week, weekIdx (weekIdx)}
								<DatePickerPrimitive.GridRow class="mt-1 flex">
									{#each week as date (date.toString())}
										<DatePickerPrimitive.Cell {date} month={month.value} class="p-0">
											<DatePickerPrimitive.Day
												class={cn(
													'grid size-8 place-items-center rounded-[3px] text-[12px] tabular-nums transition-colors',
													'text-[var(--color-parchment-200)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)]',
													'data-[outside-month]:text-[var(--color-parchment-600)] data-[outside-month]:opacity-60',
													'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-30 data-[disabled]:hover:bg-transparent',
													'data-[selected]:bg-[var(--color-brass-300)] data-[selected]:text-[var(--color-ink-950)] data-[selected]:hover:bg-[var(--color-brass-300)] data-[selected]:hover:text-[var(--color-ink-950)]',
													'data-[today]:ring-1 data-[today]:ring-[var(--color-brass-300)]/50',
													'focus:outline-none focus-visible:ring-[2px] focus-visible:ring-[var(--color-brass-300)]/40'
												)}
											/>
										</DatePickerPrimitive.Cell>
									{/each}
								</DatePickerPrimitive.GridRow>
							{/each}
						</DatePickerPrimitive.GridBody>
					</DatePickerPrimitive.Grid>
				{/each}
			{/snippet}
		</DatePickerPrimitive.Calendar>
	</DatePickerPrimitive.Content>
</DatePickerPrimitive.Root>

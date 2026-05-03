<script lang="ts">
	import { AlertTriangle, AlertOctagon, CheckCircle2, Info, X } from 'lucide-svelte';
	import { toast, type ToastEntry, type ToastKind } from './toast.svelte';

	const ICONS: Record<ToastKind, typeof Info> = {
		info: Info,
		success: CheckCircle2,
		warn: AlertTriangle,
		error: AlertOctagon
	};

	// Tone palette mirrors the existing app vocabulary: olive for go, oxblood
	// for stop, brass for the "look here" warn state, parchment for neutral.
	const ACCENTS: Record<ToastKind, { bar: string; icon: string }> = {
		info: { bar: 'var(--color-parchment-400)', icon: 'var(--color-parchment-300)' },
		success: { bar: 'var(--color-olive-300)', icon: 'var(--color-olive-300)' },
		warn: { bar: 'var(--color-brass-300)', icon: 'var(--color-brass-300)' },
		error: { bar: 'var(--color-oxblood-300)', icon: 'var(--color-oxblood-300)' }
	};

	function dismiss(t: ToastEntry) {
		toast.dismiss(t.id);
	}
</script>

<div
	class="safe-top-toaster pointer-events-none fixed right-3 z-[60] flex w-[min(92vw,360px)] flex-col gap-2 sm:right-5"
	aria-live="polite"
	aria-atomic="false"
>
	{#each toast.toasts as t (t.id)}
		{@const Icon = ICONS[t.kind]}
		{@const accent = ACCENTS[t.kind]}
		<div
			role={t.kind === 'error' ? 'alert' : 'status'}
			class="ink-panel ot-fade pointer-events-auto flex items-start gap-3 border-l-2 p-3 pr-2 shadow-[0_12px_28px_-12px_rgba(0,0,0,0.6)]"
			style="border-left-color: {accent.bar};"
		>
			<Icon class="mt-0.5 size-4 shrink-0" style="color: {accent.icon};" />
			<div class="min-w-0 flex-1">
				<div class="font-serif text-sm leading-snug text-[var(--color-parchment-50)]">
					{t.title}
				</div>
				{#if t.body}
					<div
						class="mt-0.5 font-serif text-xs leading-snug text-[var(--color-parchment-400)] italic"
					>
						{t.body}
					</div>
				{/if}
			</div>
			<button
				type="button"
				class="-mt-1 -mr-1 flex size-6 shrink-0 items-center justify-center rounded-[3px] text-[var(--color-parchment-500)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)]"
				aria-label="Dismiss notification"
				onclick={() => dismiss(t)}
			>
				<X class="size-3.5" />
			</button>
		</div>
	{/each}
</div>

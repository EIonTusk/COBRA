<script lang="ts">
	import { activeConfirm } from './confirm';
	import Button from './Button.svelte';

	let state = $state($activeConfirm);

	// Sync the local state with the store — reactive mirror so the modal
	// opens/closes when callers push new prompts.
	$effect(() => {
		const unsub = activeConfirm.subscribe((v) => (state = v));
		return unsub;
	});

	function close(ok: boolean) {
		const s = state;
		if (!s) return;
		activeConfirm.set(null);
		s.resolve(ok);
	}

	function onBackdrop(e: MouseEvent) {
		// Only cancel when the click is on the backdrop itself, not a child.
		if (e.target === e.currentTarget) close(false);
	}

	function onKey(e: KeyboardEvent) {
		if (!state) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			close(false);
		} else if (e.key === 'Enter') {
			// Enter confirms only when no other input has focus (don't swallow
			// Enter inside textareas or form inputs the user may layer on top).
			if (
				e.target instanceof HTMLTextAreaElement ||
				e.target instanceof HTMLInputElement ||
				e.target instanceof HTMLSelectElement
			) {
				return;
			}
			e.preventDefault();
			close(true);
		}
	}
</script>

<svelte:window on:keydown={onKey} />

{#if state}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-ink-950)]/70 px-4 py-10 backdrop-blur-sm"
		role="presentation"
		onmousedown={onBackdrop}
	>
		<div
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="cobra-confirm-title"
			aria-describedby="cobra-confirm-message"
			class="ink-panel ot-scale-in w-full max-w-md p-6 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]"
		>
			{#if state.title}
				<h2
					id="cobra-confirm-title"
					class="font-serif text-2xl leading-tight text-[var(--color-parchment-50)]"
				>
					{state.title}
				</h2>
			{/if}
			<p
				id="cobra-confirm-message"
				class={state.title
					? 'mt-2 font-serif text-sm leading-relaxed text-[var(--color-parchment-300)]'
					: 'font-serif text-base leading-relaxed text-[var(--color-parchment-100)]'}
			>
				{state.message}
			</p>

			<div class="mt-6 flex justify-end gap-2">
				<Button type="button" variant="ghost" size="md" onclick={() => close(false)}>
					{state.cancelLabel ?? 'Cancel'}
				</Button>
				<!--
					autofocus so keyboard users land directly on the primary action
					when the dialog opens. Shift+Tab still moves to Cancel first,
					so this doesn't trap them. aria-modal ensures screen readers
					scope virtual cursor to the dialog while it's open.
				-->
				<Button
					type="button"
					variant={state.variant === 'destructive' ? 'destructive' : 'primary'}
					size="md"
					autofocus
					onclick={() => close(true)}
				>
					{state.confirmLabel ?? 'Confirm'}
				</Button>
			</div>
		</div>
	</div>
{/if}

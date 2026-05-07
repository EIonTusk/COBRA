<script lang="ts">
	import { Button } from '$lib/ui';
	import { sync } from './syncStore.svelte';

	const conflict = $derived(sync.conflict);
	const subject = $derived.by(() => {
		if (!conflict) return '';
		return conflict.kind === 'global' ? 'Global settings + dossier' : 'A repertoire';
	});

	function pullRemote() {
		void sync.resolveConflictPullRemote();
	}
	function overwriteRemote() {
		void sync.resolveConflictOverwrite();
	}
	function dismiss() {
		sync.dismissConflict();
	}

	function fmtDate(ms: number): string {
		try {
			return new Date(ms).toLocaleString();
		} catch {
			return String(ms);
		}
	}
</script>

{#if conflict}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-ink-950)]/70 px-4 py-10 backdrop-blur-sm"
		role="presentation"
	>
		<div
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="cobra-sync-conflict-title"
			class="ink-panel ot-scale-in w-full max-w-lg p-6 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]"
		>
			<h2
				id="cobra-sync-conflict-title"
				class="font-serif text-2xl leading-tight text-[var(--color-parchment-50)]"
			>
				Sync conflict <span class="eyebrow ml-2 text-[var(--color-brass-300)]">Beta</span>
			</h2>
			<p class="mt-2 font-serif text-sm leading-relaxed text-[var(--color-parchment-300)]">
				{subject} was updated by another device since this one last synced.
			</p>

			<div
				class="mt-4 grid gap-2 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] p-3 font-mono text-xs"
			>
				<div class="flex justify-between gap-3">
					<span class="text-[var(--color-parchment-500)]">Remote revision</span>
					<span>{conflict.remoteRevision}</span>
				</div>
				<div class="flex justify-between gap-3">
					<span class="text-[var(--color-parchment-500)]">Remote pushed at</span>
					<span>{fmtDate(conflict.remotePushedAt)}</span>
				</div>
				<div class="flex justify-between gap-3">
					<span class="text-[var(--color-parchment-500)]">Remote device</span>
					<span class="truncate">{conflict.remoteDeviceId.slice(0, 8)}…</span>
				</div>
				<div class="flex justify-between gap-3">
					<span class="text-[var(--color-parchment-500)]">Last seen here</span>
					<span>{conflict.localRevision >= 0 ? `r${conflict.localRevision}` : '—'}</span>
				</div>
			</div>

			<p class="mt-4 font-serif text-xs leading-relaxed text-[var(--color-parchment-400)] italic">
				Pull merges the remote's data into this device by record (most-recent review wins per card,
				edges union, the most recent of drilled-or-dismissed wins per mistake). Overwrite pushes
				this device's copy on top of the remote — the other device will see this same prompt on its
				next sync. Cancel keeps the dirty mark so the next push tries again.
			</p>

			<div class="mt-6 flex flex-wrap justify-end gap-2">
				<Button type="button" variant="ghost" size="md" onclick={dismiss}>Cancel</Button>
				<Button type="button" variant="outline" size="md" onclick={overwriteRemote}>
					Overwrite remote
				</Button>
				<Button type="button" variant="primary" size="md" onclick={pullRemote}>Pull remote</Button>
			</div>
		</div>
	</div>
{/if}

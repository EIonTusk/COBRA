<script lang="ts">
	import { sync } from './syncStore.svelte';
	import { Badge } from '$lib/ui';

	const status = $derived(sync.status);
	const lastPushAt = $derived(sync.lastPushAt);
	const lastPullAt = $derived(sync.lastPullAt);

	const lastSyncAt = $derived.by(() => {
		const a = lastPushAt ?? 0;
		const b = lastPullAt ?? 0;
		return Math.max(a, b);
	});

	const label = $derived.by(() => {
		switch (status) {
			case 'pulling':
				return 'Pulling…';
			case 'pushing':
				return 'Pushing…';
			case 'conflict':
				return 'Conflict';
			case 'error':
				return 'Sync error';
			default:
				if (lastSyncAt > 0) return `Synced ${fmtAgo(lastSyncAt)}`;
				return 'Synced';
		}
	});

	const variant = $derived.by(() => {
		if (status === 'conflict' || status === 'error') return 'oxblood' as const;
		if (status === 'pulling' || status === 'pushing') return 'brass' as const;
		return 'olive' as const;
	});

	function fmtAgo(ms: number): string {
		const delta = Date.now() - ms;
		if (delta < 60_000) return 'just now';
		if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`;
		if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`;
		return `${Math.floor(delta / (24 * 60 * 60_000))}d ago`;
	}

	function onClick() {
		if (status === 'conflict') return; // modal already handles it
		void sync.syncNow();
	}
</script>

{#if sync.enabled}
	<button
		type="button"
		onclick={onClick}
		class="inline-flex items-center gap-1.5 transition-opacity hover:opacity-80"
		title={status === 'error' && sync.error ? sync.error : 'Click to sync now'}
		aria-label="Sync status — click to sync now"
	>
		<Badge {variant}>{label}</Badge>
		<span
			class="eyebrow text-[10px] tracking-[0.18em] text-[var(--color-parchment-500)]"
			aria-hidden="true"
		>
			Beta
		</span>
	</button>
{/if}

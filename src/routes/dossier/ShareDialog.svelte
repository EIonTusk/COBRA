<script lang="ts">
	import { Copy, Download, X } from 'lucide-svelte';

	interface Props {
		open: boolean;
		/** True while the share payload is being built (gzip + base64). */
		encoding: boolean;
		/** Last error from the encode step, or null. */
		error: string | null;
		/** Encoded share URL. null while still encoding or after a fresh open. */
		url: string | null;
		/** Size estimate of the encoded payload, or null while encoding. */
		size: { base64Chars: number; jsonBytes: number } | null;
		/** Transient status string ("Link copied.", "Download started.", or empty). */
		copyStatus: string;
		onClose: () => void;
		onCopy: () => void;
		onDownload: () => void;
	}

	let { open, encoding, error, url, size, copyStatus, onClose, onCopy, onDownload }: Props =
		$props();

	function formatKB(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(2)} MB`;
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="share-title"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) onClose();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') onClose();
		}}
	>
		<div
			class="w-full max-w-xl rounded border border-[var(--color-brass-300)]/40 bg-[var(--color-ink-900)] shadow-2xl"
		>
			<div
				class="flex items-center justify-between border-b border-[var(--color-ink-800)] px-5 py-3"
			>
				<div>
					<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
						Share report
					</div>
					<h3 id="share-title" class="mt-0.5 font-serif text-lg text-[var(--color-parchment-50)]">
						Hand this report to someone
					</h3>
				</div>
				<button
					type="button"
					onclick={onClose}
					class="text-[var(--color-parchment-400)] hover:text-[var(--color-parchment-100)]"
					aria-label="Close"
				>
					<X class="size-4" />
				</button>
			</div>

			<div class="space-y-4 px-5 py-5 text-sm text-[var(--color-parchment-200)]">
				<p class="leading-relaxed text-[var(--color-parchment-300)]">
					Share bundles the full scan — classified games, engine moves, and every finding — into a
					single encoded string. The recipient opens the link, previews what they're about to
					import, and decides whether to adopt it as their local report.
				</p>

				{#if encoding}
					<p class="text-xs text-[var(--color-parchment-500)]">Compressing report…</p>
				{:else if error}
					<p class="text-xs text-red-400">{error}</p>
				{:else if url && size}
					<div>
						<label
							class="mb-1 block text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
							for="share-url"
						>
							Share link
						</label>
						<div class="flex gap-2">
							<input
								id="share-url"
								type="text"
								readonly
								value={url}
								class="flex-1 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-2 py-1.5 font-mono text-xs text-[var(--color-parchment-200)]"
								onclick={(e) => (e.currentTarget as HTMLInputElement).select()}
							/>
							<button
								type="button"
								onclick={onCopy}
								class="inline-flex items-center gap-1 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-2 py-1.5 text-xs hover:border-[var(--color-brass-300)]/40"
							>
								<Copy class="size-3" />
								Copy
							</button>
						</div>
						<p class="mt-1.5 text-[10px] text-[var(--color-parchment-500)]">
							Encoded payload: <span class="font-mono">{size.base64Chars.toLocaleString()}</span>
							base64 chars · raw <span class="font-mono">{formatKB(size.jsonBytes)}</span>
							{#if size.base64Chars > 500_000}
								·
								<span class="text-amber-300">
									Very long URL — some mail clients will truncate. Prefer the file download below.
								</span>
							{:else if size.base64Chars > 100_000}
								· <span class="text-[var(--color-parchment-400)]"
									>URL is long — some chat apps may shorten it; download as file if in doubt.</span
								>
							{/if}
						</p>
					</div>

					<div class="border-t border-[var(--color-ink-800)] pt-4">
						<label
							class="mb-1 block text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
							for="share-download"
						>
							Or download as a file
						</label>
						<button
							id="share-download"
							type="button"
							onclick={onDownload}
							class="inline-flex items-center gap-1 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-3 py-1.5 text-xs hover:border-[var(--color-brass-300)]/40"
						>
							<Download class="size-3" />
							Download .json
						</button>
						<p class="mt-1.5 text-[10px] text-[var(--color-parchment-500)]">
							Recipient uploads the file at <span class="font-mono">/dossier/shared</span>. Works
							for reports of any size.
						</p>
					</div>

					{#if copyStatus}
						<p class="text-xs text-emerald-400">{copyStatus}</p>
					{/if}

					<p
						class="border-t border-[var(--color-ink-800)] pt-3 text-[10px] text-[var(--color-parchment-500)]"
					>
						Shared bundles contain opponent usernames, game IDs, and ratings from the scan — same
						information Lichess / chess.com make public on your games. Don't share if your game
						history should stay private.
					</p>
				{/if}
			</div>
		</div>
	</div>
{/if}

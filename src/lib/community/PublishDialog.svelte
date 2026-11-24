<script lang="ts">
	import { untrack } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { Copy, Globe, ShieldCheck, X } from 'lucide-svelte';
	import { Button, confirmDialog } from '$lib/ui';
	import { getSettings } from '$lib/storage/settings';
	import { setCommunityPublication } from '$lib/storage/repertoires';
	import type { Repertoire } from '$lib/types';
	import { buildCommunityTree, type BuiltTree } from './buildTree';
	import { CommunityClient, CommunityError } from './client';
	import { COMMUNITY_LIMITS, type PublishMeta } from './types';

	interface Props {
		open: boolean;
		rep: Repertoire;
		onClose: () => void;
		/** Called after publishing or unpublishing, with the updated repertoire. */
		onChanged: (rep: Repertoire) => void;
	}

	let { open, rep, onClose, onChanged }: Props = $props();

	let client = $state<CommunityClient | null>(null);
	let setupProblem = $state<string | null>(null);
	let loading = $state(true);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let duplicateOf = $state<string | null>(null);
	let publishedId = $state<string | null>(null);
	let copied = $state(false);

	let title = $state('');
	let description = $state('');
	let tagsText = $state('');
	let visibility = $state<'public' | 'unlisted'>('public');
	let showAuthor = $state(true);
	let includeComments = $state(true);
	let includeIdeaCards = $state(true);
	let changelog = $state('');
	let built = $state<BuiltTree | null>(null);
	let showTexts = $state(false);

	const isUpdate = $derived(!!rep.communityPublication);
	const shareUrl = $derived(
		publishedId && typeof window !== 'undefined'
			? `${window.location.origin}${base}/community/${publishedId}`
			: null
	);

	$effect(() => {
		// Reset the form each time the dialog opens, not when `rep` changes
		// after a publish.
		if (open) untrack(() => void init());
	});

	// Rebuild the preview whenever the content switches change.
	$effect(() => {
		if (!open) return;
		const opts = { includeComments, includeIdeaCards };
		void buildCommunityTree(rep.id, opts).then((b) => (built = b));
	});

	async function init() {
		loading = true;
		error = null;
		duplicateOf = null;
		copied = false;
		publishedId = rep.communityPublication?.publicationId ?? null;
		title = rep.name;
		description = '';
		tagsText = '';
		visibility = 'public';
		showAuthor = true;
		changelog = '';
		const settings = await getSettings();
		client = CommunityClient.fromSettings(settings);
		if (!client) {
			setupProblem =
				'Community openings need the hosted COBRA server. Set the Cloudflare sync URL in Settings.';
		} else if (!client.canSignIn) {
			setupProblem = 'Connect Lichess in Settings to publish. Browsing works without it.';
		} else {
			setupProblem = null;
		}
		if (client && rep.communityPublication) {
			// Prefill from what is published now.
			try {
				const pub = await client.get(rep.communityPublication.publicationId);
				title = pub.title;
				description = pub.description;
				tagsText = pub.tags.join(', ');
				visibility = pub.visibility;
				showAuthor = pub.showAuthor;
			} catch (e) {
				if (e instanceof CommunityError && e.status === 404) {
					// Removed by a moderator or purged: start over as a new publication.
					await setCommunityPublication(rep.id, null);
					rep = { ...rep, communityPublication: null };
					onChanged(rep);
					publishedId = null;
				}
			}
		}
		loading = false;
	}

	function meta(): PublishMeta {
		return {
			title: title.trim(),
			description: description.trim(),
			tags: tagsText
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean)
				.slice(0, COMMUNITY_LIMITS.maxTags),
			visibility,
			showAuthor,
			changelog: changelog.trim(),
			forkedFrom: rep.communitySource?.publicationId ?? null
		};
	}

	async function onPublish() {
		if (!client || !built || built.tooLarge) return;
		busy = true;
		error = null;
		duplicateOf = null;
		try {
			const res = rep.communityPublication
				? await client.update(rep.communityPublication.publicationId, meta(), built.tree)
				: await client.publish(meta(), built.tree);
			const link = {
				publicationId: res.id,
				version: res.version,
				publishedAt: Date.now(),
				visibility
			};
			await setCommunityPublication(rep.id, link);
			rep = { ...rep, communityPublication: link };
			publishedId = res.id;
			onChanged(rep);
		} catch (e) {
			if (e instanceof CommunityError && e.status === 409 && typeof e.body.id === 'string') {
				duplicateOf = e.body.id;
			}
			error = e instanceof Error ? e.message : 'Publishing failed.';
		} finally {
			busy = false;
		}
	}

	async function onUnpublish() {
		if (!client || !rep.communityPublication) return;
		const ok = await confirmDialog({
			title: 'Unpublish this opening?',
			message:
				'It disappears from the community right away. Copies other people already imported stay theirs.',
			confirmLabel: 'Unpublish',
			variant: 'destructive'
		});
		if (!ok) return;
		busy = true;
		error = null;
		try {
			await client.unpublish(rep.communityPublication.publicationId);
		} catch (e) {
			if (!(e instanceof CommunityError && e.status === 404)) {
				error = e instanceof Error ? e.message : 'Unpublishing failed.';
				busy = false;
				return;
			}
		}
		await setCommunityPublication(rep.id, null);
		rep = { ...rep, communityPublication: null };
		publishedId = null;
		onChanged(rep);
		busy = false;
	}

	function count(n: number, noun: string): string {
		return `${n} ${noun}${n === 1 ? '' : 's'}`;
	}

	function summaryLine(b: BuiltTree): string {
		const parts = [count(b.stats.positions, 'position'), count(b.stats.moves, 'move')];
		if (includeComments) parts.push(count(b.stats.comments, 'comment'));
		if (includeIdeaCards) parts.push(count(b.stats.ideaCards, 'idea card'));
		return parts.join(' · ');
	}

	async function copyLink() {
		if (!shareUrl) return;
		try {
			await navigator.clipboard.writeText(shareUrl);
			copied = true;
		} catch {
			copied = false;
		}
	}

	const inputClass =
		'w-full rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-2 py-1.5 text-sm text-[var(--color-parchment-100)] focus:border-[var(--color-brass-300)]/60 focus:outline-none';
	const labelClass =
		'mb-1 block text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase';
</script>

<svelte:window
	onkeydown={(e) => {
		if (open && e.key === 'Escape' && !busy) onClose();
	}}
/>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="publish-title"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget && !busy) onClose();
		}}
	>
		<div
			class="flex max-h-[92vh] w-full max-w-xl flex-col rounded border border-[var(--color-brass-300)]/40 bg-[var(--color-ink-900)] shadow-2xl"
		>
			<div
				class="flex items-center justify-between border-b border-[var(--color-ink-800)] px-5 py-3"
			>
				<div>
					<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
						Community
					</div>
					<h3 id="publish-title" class="mt-0.5 font-serif text-lg text-[var(--color-parchment-50)]">
						{isUpdate ? 'Update your published opening' : 'Publish to the community'}
					</h3>
				</div>
				<button
					type="button"
					onclick={onClose}
					disabled={busy}
					class="text-[var(--color-parchment-400)] hover:text-[var(--color-parchment-100)]"
					aria-label="Close"
				>
					<X class="size-4" />
				</button>
			</div>

			<div class="space-y-4 overflow-y-auto px-5 py-5 text-sm text-[var(--color-parchment-200)]">
				<div
					class="flex gap-2.5 rounded border border-emerald-700/40 bg-emerald-950/30 px-3 py-2.5 text-xs leading-relaxed text-emerald-200"
					data-testid="publish-privacy-note"
				>
					<ShieldCheck class="mt-0.5 size-4 shrink-0" />
					<span>
						Only your moves{includeComments ? ', comments' : ''}{includeIdeaCards
							? ' and idea-card text'
							: ''} are published. Your training progress, mistakes and shelved lines never leave this
						device.
					</span>
				</div>

				{#if loading}
					<p class="text-xs text-[var(--color-parchment-500)]">Loading…</p>
				{:else if setupProblem}
					<p class="text-xs text-amber-300" data-testid="publish-setup-problem">{setupProblem}</p>
				{:else}
					{#if shareUrl}
						<div data-testid="publish-link">
							<span class={labelClass}>Link</span>
							<div class="flex gap-2">
								<input readonly value={shareUrl} class="{inputClass} font-mono text-xs" />
								<Button size="sm" variant="outline" onclick={copyLink}>
									<Copy class="size-3" />
									{copied ? 'Copied' : 'Copy'}
								</Button>
							</div>
							{#if rep.communityPublication}
								<p class="mt-1 text-[11px] text-[var(--color-parchment-500)]">
									Published version {rep.communityPublication.version}
									· {rep.communityPublication.visibility === 'public'
										? 'listed in the community'
										: 'unlisted, only people with the link can open it'}
								</p>
							{/if}
						</div>
					{/if}

					<div>
						<label class={labelClass} for="pub-title">Title</label>
						<input
							id="pub-title"
							class={inputClass}
							bind:value={title}
							maxlength={COMMUNITY_LIMITS.maxTitle}
						/>
					</div>
					<div>
						<label class={labelClass} for="pub-desc">Description</label>
						<textarea
							id="pub-desc"
							class="{inputClass} min-h-20"
							bind:value={description}
							maxlength={COMMUNITY_LIMITS.maxDescription}
							placeholder="What the repertoire aims for, who it suits…"
						></textarea>
					</div>
					<div>
						<label class={labelClass} for="pub-tags">Tags (comma separated)</label>
						<input
							id="pub-tags"
							class={inputClass}
							bind:value={tagsText}
							placeholder="solid, beginner"
						/>
					</div>

					<fieldset class="space-y-1.5">
						<legend class={labelClass}>Visibility</legend>
						<label class="flex items-start gap-2">
							<input type="radio" bind:group={visibility} value="public" class="mt-1" />
							<span>
								<b class="font-medium text-[var(--color-parchment-100)]">Public</b>
								<span class="block text-xs text-[var(--color-parchment-500)]">
									Listed and searchable, and its moves count towards community statistics.
								</span>
							</span>
						</label>
						<label class="flex items-start gap-2">
							<input type="radio" bind:group={visibility} value="unlisted" class="mt-1" />
							<span>
								<b class="font-medium text-[var(--color-parchment-100)]">Unlisted</b>
								<span class="block text-xs text-[var(--color-parchment-500)]">
									Only people with the link can open it.
								</span>
							</span>
						</label>
					</fieldset>

					<div class="space-y-1.5">
						<label class="flex items-center gap-2">
							<input type="checkbox" bind:checked={showAuthor} data-testid="publish-show-author" />
							<span>Show my Lichess username (otherwise shown as anonymous)</span>
						</label>
						<label class="flex items-center gap-2">
							<input
								type="checkbox"
								bind:checked={includeComments}
								data-testid="publish-include-comments"
							/>
							<span>Include my comments</span>
						</label>
						<label class="flex items-center gap-2">
							<input
								type="checkbox"
								bind:checked={includeIdeaCards}
								data-testid="publish-include-ideas"
							/>
							<span>Include idea cards (prompt and answer only)</span>
						</label>
					</div>

					{#if isUpdate}
						<div>
							<label class={labelClass} for="pub-changelog">What changed (optional)</label>
							<input
								id="pub-changelog"
								class={inputClass}
								bind:value={changelog}
								maxlength={COMMUNITY_LIMITS.maxChangelog}
							/>
						</div>
					{/if}

					{#if built}
						<div
							class="rounded border border-[var(--color-ink-800)] px-3 py-2 text-xs"
							data-testid="publish-summary"
						>
							<p>
								{summaryLine(built)}
							</p>
							{#if built.stats.shelvedSkipped > 0}
								<p class="mt-1 text-[var(--color-parchment-500)]">
									{count(built.stats.shelvedSkipped, 'shelved move')} left out.
								</p>
							{/if}
							{#if built.texts.length > 0}
								<button
									type="button"
									class="mt-1 text-[var(--color-brass-300)] underline underline-offset-2"
									onclick={() => (showTexts = !showTexts)}
								>
									{showTexts ? 'Hide' : 'Review'} the text that will be published
								</button>
								{#if showTexts}
									<ul class="mt-2 max-h-40 space-y-1 overflow-y-auto" data-testid="publish-texts">
										{#each built.texts as t, i (i)}
											<li class="text-[var(--color-parchment-300)]">
												<span class="text-[var(--color-parchment-500)]">{t.kind}:</span>
												{t.text}
											</li>
										{/each}
									</ul>
								{/if}
							{/if}
							{#if built.tooLarge}
								<p class="mt-1 text-amber-300">{built.tooLarge}</p>
							{/if}
						</div>
					{/if}

					{#if error}
						<p class="text-xs text-red-400" data-testid="publish-error">
							{error}
							{#if duplicateOf}
								<a class="underline" href={resolve(`/community/${duplicateOf}`)}>Open it</a>
							{/if}
						</p>
					{/if}
				{/if}
			</div>

			<div
				class="flex items-center justify-between gap-2 border-t border-[var(--color-ink-800)] px-5 py-3"
			>
				<div>
					{#if isUpdate && !setupProblem}
						<Button size="sm" variant="destructive" disabled={busy} onclick={onUnpublish}
							>Unpublish</Button
						>
					{/if}
				</div>
				<div class="flex gap-2">
					<Button size="sm" variant="ghost" disabled={busy} onclick={onClose}>Close</Button>
					<Button
						size="sm"
						disabled={busy ||
							loading ||
							!!setupProblem ||
							!built ||
							!!built.tooLarge ||
							!title.trim()}
						onclick={onPublish}
						data-testid="publish-submit"
					>
						<Globe class="size-3.5" />
						{busy ? 'Publishing…' : isUpdate ? 'Publish update' : 'Publish'}
					</Button>
				</div>
			</div>
		</div>
	</div>
{/if}

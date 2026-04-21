<script lang="ts">
	import { base } from '$app/paths';
	import { ArrowLeft } from 'lucide-svelte';
	import { cn } from './utils';

	type Props = {
		class?: string;
		href?: string;
		label?: string;
	};

	let { class: className, href, label = 'Dashboard' }: Props = $props();
	const target = $derived(href ?? `${base}/`);
</script>

<!--
	Renders inline above the heading on narrow viewports, and absolutely
	positioned into the left gutter from xl: breakpoint up. The parent
	wrapper MUST have `position: relative` for the gutter placement to
	anchor to the content column. Gutter offset (top-14) is tuned for
	containers that use pt-14 — it lines the back-link up with the eyebrow
	that follows it.
-->
<!-- eslint-disable svelte/no-navigation-without-resolve -->
<a
	href={target}
	class={cn(
		'eyebrow mb-5 inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]',
		'xl:absolute xl:top-14 xl:right-full xl:mr-6 xl:mb-0 xl:whitespace-nowrap',
		className
	)}
>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
	<ArrowLeft class="size-3" />
	<span>{label}</span>
</a>

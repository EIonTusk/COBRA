/**
 * Svelte action that smoothly animates an element's height when its content
 * changes — useful for cards that swap between different states with
 * different intrinsic heights (e.g. a right-rail prompt that cycles between
 * "your move", "wrong", "refuted", "game complete"), or panels whose text
 * grows as data streams in.
 *
 * Mechanism: a single ResizeObserver watches the element. When the rendered
 * `scrollHeight` diverges from the previous frame's height, we briefly snap
 * the element's height back to the old value, force a reflow, then animate
 * `height` to the new value over `duration`. After the animation we drop
 * the inline `height`/`transition` styles so the element is back to its
 * natural sizing — no max-height workarounds, no JS-managed sizes after
 * the transition completes.
 *
 * Caveats:
 *  - Sets `overflow: hidden` on the element while the transition runs
 *    (cleared on teardown). If the element relied on visible overflow it
 *    will be clipped during transitions.
 *  - The `<{ duration?: number; disabled?: boolean }>` parameter is
 *    optional. `disabled: true` keeps the observer alive (so internal
 *    bookkeeping stays accurate) but skips animations — handy to silence
 *    the action during initial mount or while a parent is in a transition
 *    of its own.
 *  - Width-only resizes don't trigger an animation; we compare scrollHeight
 *    deltas, not the ResizeObserver entry's contentRect width.
 */

export interface AutoHeightOptions {
	/** Animation duration in ms. Default 220 — matches the slide/flip rows. */
	duration?: number;
	/** When true, skip animations but keep the observer running. */
	disabled?: boolean;
}

export function autoHeight(node: HTMLElement, opts: AutoHeightOptions = {}) {
	let duration = opts.duration ?? 220;
	let disabled = opts.disabled ?? false;
	let prev = node.offsetHeight;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const originalOverflow = node.style.overflow;

	const ro = new ResizeObserver(() => {
		const target = node.scrollHeight;
		// Tolerance avoids loops when the animation itself shows up as a
		// resize event mid-transition.
		if (Math.abs(target - prev) < 1) return;
		const from = prev;
		prev = target;
		if (disabled) return;
		// Don't animate the very first observation when prev was already
		// up-to-date. (Subsequent observations always have a real `from`.)
		if (from === 0) return;

		node.style.overflow = 'hidden';
		node.style.transition = 'none';
		node.style.height = `${from}px`;
		// Force layout so the height swap takes effect before the
		// transition is reapplied. Reading offsetHeight is the standard
		// reflow-trigger.
		void node.offsetHeight;
		node.style.transition = `height ${duration}ms cubic-bezier(0.2, 0.7, 0.2, 1)`;
		node.style.height = `${target}px`;

		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			node.style.height = '';
			node.style.transition = '';
			node.style.overflow = originalOverflow;
			timer = null;
		}, duration + 30);
	});
	ro.observe(node);

	return {
		update(nextOpts: AutoHeightOptions = {}) {
			duration = nextOpts.duration ?? 220;
			disabled = nextOpts.disabled ?? false;
		},
		destroy() {
			ro.disconnect();
			if (timer) clearTimeout(timer);
			node.style.height = '';
			node.style.transition = '';
			node.style.overflow = originalOverflow;
		}
	};
}

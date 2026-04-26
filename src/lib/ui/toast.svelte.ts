/**
 * Lightweight runes-based toast queue. Mount `<Toaster />` once in the root
 * layout; callers anywhere can `toast.error(title, body?)` etc. Auto-dismisses
 * after a kind-dependent timeout (errors stick longer); pass `0` to make a
 * toast sticky. The queue caps itself at MAX_TOASTS so a runaway loop can't
 * pile up an unbounded list.
 */

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface ToastEntry {
	id: number;
	kind: ToastKind;
	title: string;
	body?: string;
	/** Wall-clock ms before auto-dismiss; 0 = sticky. */
	durationMs: number;
}

export interface ToastOptions {
	body?: string;
	/** Override the default auto-dismiss for this toast. 0 makes it sticky. */
	durationMs?: number;
	/**
	 * Dedup key. If a toast with the same key is already on screen, the new
	 * call is a no-op — useful for engine-error spam where the same failure
	 * fires repeatedly across a scan.
	 */
	dedupKey?: string;
}

const DEFAULT_DURATIONS: Record<ToastKind, number> = {
	info: 4500,
	success: 4500,
	warn: 6000,
	error: 8000
};

const MAX_TOASTS = 5;

class ToastStore {
	toasts = $state<ToastEntry[]>([]);
	#nextId = 1;
	#dedupKeys = new Map<string, number>();

	push(kind: ToastKind, title: string, opts: ToastOptions = {}): number {
		if (opts.dedupKey) {
			const existing = this.#dedupKeys.get(opts.dedupKey);
			if (existing !== undefined && this.toasts.some((t) => t.id === existing)) {
				return existing;
			}
		}
		const id = this.#nextId++;
		const dur = opts.durationMs ?? DEFAULT_DURATIONS[kind];
		const entry: ToastEntry = {
			id,
			kind,
			title,
			body: opts.body,
			durationMs: dur
		};
		// Trim oldest when over the cap so the screen never fills with stale
		// notices during long-running scans.
		const next = [...this.toasts, entry];
		this.toasts = next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
		if (opts.dedupKey) this.#dedupKeys.set(opts.dedupKey, id);
		if (dur > 0 && typeof window !== 'undefined') {
			window.setTimeout(() => this.dismiss(id), dur);
		}
		return id;
	}

	dismiss(id: number): void {
		this.toasts = this.toasts.filter((t) => t.id !== id);
		for (const [k, v] of this.#dedupKeys) {
			if (v === id) this.#dedupKeys.delete(k);
		}
	}

	clear(): void {
		this.toasts = [];
		this.#dedupKeys.clear();
	}

	info(title: string, opts: ToastOptions | string = {}): number {
		return this.push('info', title, normaliseOpts(opts));
	}
	success(title: string, opts: ToastOptions | string = {}): number {
		return this.push('success', title, normaliseOpts(opts));
	}
	warn(title: string, opts: ToastOptions | string = {}): number {
		return this.push('warn', title, normaliseOpts(opts));
	}
	error(title: string, opts: ToastOptions | string = {}): number {
		return this.push('error', title, normaliseOpts(opts));
	}
}

function normaliseOpts(opts: ToastOptions | string): ToastOptions {
	return typeof opts === 'string' ? { body: opts } : opts;
}

export const toast = new ToastStore();

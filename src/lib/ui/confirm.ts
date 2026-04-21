/**
 * Promise-based confirm dialog. Replaces `window.confirm()` with a styled
 * in-app modal. Mount `<ConfirmDialog />` once in the root layout; callers
 * anywhere can then `await confirmDialog(...)` and get true/false.
 */

import { writable } from 'svelte/store';

export interface ConfirmOptions {
	title?: string;
	message: string;
	/** Label for the affirmative button. Defaults to "Confirm". */
	confirmLabel?: string;
	/** Label for the cancel button. Defaults to "Cancel". */
	cancelLabel?: string;
	/**
	 * Visual variant for the affirmative button. Use 'destructive' for
	 * delete / wipe / overwrite actions so the button reads red.
	 */
	variant?: 'default' | 'destructive';
}

interface DialogState extends ConfirmOptions {
	resolve: (ok: boolean) => void;
}

export const activeConfirm = writable<DialogState | null>(null);

export function confirmDialog(opts: ConfirmOptions | string): Promise<boolean> {
	const normalised: ConfirmOptions = typeof opts === 'string' ? { message: opts } : opts;
	return new Promise<boolean>((resolve) => {
		activeConfirm.set({ ...normalised, resolve });
	});
}

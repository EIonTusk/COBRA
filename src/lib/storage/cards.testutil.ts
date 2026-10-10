import type { Card } from '$lib/types';
import { toProgress, toSlot } from './moveProgress';

type Putter = { put: (row: never) => Promise<unknown> };

/**
 * Seed a joined `Card` straight into an open transaction: its slot into
 * `cards` and its progress into `move_progress` (issue #97). The transaction
 * must include both stores.
 */
export async function putCardRows(
	tx: { objectStore: (name: 'cards' | 'move_progress') => unknown },
	card: Card
): Promise<void> {
	await (tx.objectStore('cards') as Putter).put(toSlot(card) as never);
	await (tx.objectStore('move_progress') as Putter).put(toProgress(card) as never);
}

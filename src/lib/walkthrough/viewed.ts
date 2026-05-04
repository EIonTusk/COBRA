import { getSettings, saveSettings } from '$lib/storage/settings';
import type { AppSettings } from '$lib/types';

const MAX_VIEWED = 200;

/**
 * Record that the user opened this game in the walkthrough page. Existing
 * entries get bumped to the latest timestamp; oldest entries are pruned once
 * the cap is reached.
 */
export async function markWalkthroughGameViewed(gameId: string): Promise<void> {
	if (!gameId) return;
	const s = await getSettings();
	const existing = s.viewedWalkthroughGames ?? [];
	const filtered = existing.filter((v) => v.id !== gameId);
	filtered.push({ id: gameId, viewedAt: Date.now() });
	const next = filtered.slice(-MAX_VIEWED);
	await saveSettings({ ...s, viewedWalkthroughGames: next });
}

export function viewedWalkthroughGameIds(s: AppSettings | null | undefined): Set<string> {
	if (!s?.viewedWalkthroughGames) return new Set();
	return new Set(s.viewedWalkthroughGames.map((v) => v.id));
}

import type { AppSettings, Repertoire } from '$lib/types';
import { buildSegment, segmentEventCount, segmentNewCount } from './buildSegment';
import type { DrillSegment } from './types';

/**
 * Build the quick drill: one `due` segment per repertoire. White reps come
 * first, then black — keeps a session from ping-ponging between sides. The
 * settings' `drillSessionCap` and `dailyNewCardCap` apply to the *merged*
 * session (not per rep), so each segment is built against whatever budget
 * the earlier segments left behind. Once the budget is exhausted, later reps
 * drop out of the session entirely — they'll surface in a future drill once
 * today's quota is spent. Each rep keeps its own training depth and
 * progressive-unlock setting.
 */
export async function buildQuickDrillSegments(
	reps: Repertoire[],
	settings: AppSettings
): Promise<DrillSegment[]> {
	const colorRank = (c: 'white' | 'black') => (c === 'white' ? 0 : 1);
	const ordered = [...reps].sort((a, b) => colorRank(a.color) - colorRank(b.color));
	const out: DrillSegment[] = [];
	let remainingSession = settings.drillSessionCap;
	let remainingNew = settings.dailyNewCardCap;
	for (const rep of ordered) {
		if (remainingSession <= 0) break;
		const constrained: AppSettings = {
			...settings,
			drillSessionCap: remainingSession,
			dailyNewCardCap: Math.max(0, remainingNew)
		};
		const seg = await buildSegment(rep, 'due', constrained);
		if (seg.cards.length === 0 && seg.ideaQueue.length === 0) continue;
		out.push(seg);
		remainingSession -= segmentEventCount(seg);
		remainingNew -= segmentNewCount(seg);
	}
	return out;
}

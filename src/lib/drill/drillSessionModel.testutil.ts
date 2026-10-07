// Test-only model of how DrillRunner.svelte plays a session: which cards it
// presents, how often, with or without a hint, and what it grades. The
// component itself needs a browser board and Stockfish, so the multi-session
// simulations drive this instead. Grading goes through the same
// SessionGrader the component uses; queue flow mirrors the component's rules
// (referenced by function name below) and must be kept in step with it.
//
// Not modelled (order-only, or UI-only): in-line chaining (findNextInLine —
// it presents a queued card earlier, it doesn't add presentations), alt-move
// sibling pruning (needs the user to pick a non-expected prepared reply),
// defer-subtree, hints the user asks for, idea cards.
import type { FSRSParameters } from 'ts-fsrs';
import type { DrillOutcome } from '$lib/fsrs/scheduler';
import type { Card } from '$lib/types';
import { getCard, upsertCard } from '$lib/storage/cards';
import { markMistakeByPosition } from '$lib/storage/mistakes';
import { pathToFenKey } from '$lib/tree/traversal';
import { collectReplayLeafCards, sortLeavesByLineOrder } from './buildSegment';
import { SessionGrader } from './sessionGrading';
import type { DrillSegment } from './types';

export interface Presentation {
	segIdx: number;
	repId: string;
	fenKey: string;
	/** Times this card was presented earlier in this session. */
	attempt: number;
	/** The board showed the answer (hinted introduction of a new card). */
	hinted: boolean;
	/** Pulled in as a line-walk prefix step rather than being due itself. */
	lineWalkStep: boolean;
	phase: 'learn' | 'train' | 'retry' | 'leaves' | 'queue';
}

/** User model: does the user find the right move (unhinted presentation)? */
export type Answer = (p: Presentation) => boolean;

export interface GradeEvent extends Presentation {
	outcome: DrillOutcome;
	/** Card state before this grade (as stored at the time). */
	before: Card;
	/** What was persisted, or null when the grade was skipped. */
	after: Card | null;
}

export async function playSession(
	segments: DrillSegment[],
	answer: Answer,
	params: FSRSParameters,
	now: Date
): Promise<GradeEvent[]> {
	const grader = new SessionGrader();
	const events: GradeEvent[] = [];
	const introduced = new Set<string>();
	const attempts = new Map<string, number>();
	const ck = (s: number, k: string) => `${s}::${k}`;

	/** rateAndAdvance's grading half + the presentation that precedes it. */
	const present = async (
		segIdx: number,
		card: Card,
		phase: Presentation['phase'],
		lineWalkMode: boolean
	): Promise<{ outcome: DrillOutcome; isIntroductionPass: boolean; isLineWalkStep: boolean }> => {
		const seg = segments[segIdx];
		const key = ck(segIdx, card.fenKey);
		const isMistakeReview = seg.mode === 'mistakes' || seg.mode === 'retrain';
		const isLineWalkStep = seg.mode === 'due' && !seg.dueOriginalKeys.has(card.fenKey);
		// hintLevel on presentation ($effect on currentEntry).
		const hinted = !(card.lastReview || introduced.has(key) || isLineWalkStep || isMistakeReview);
		const isIntroductionPass =
			!card.lastReview &&
			!introduced.has(key) &&
			seg.mode === 'due' &&
			!isLineWalkStep &&
			!lineWalkMode;
		const attempt = attempts.get(key) ?? 0;
		attempts.set(key, attempt + 1);
		const p: Presentation = {
			segIdx,
			repId: seg.rep.id,
			fenKey: card.fenKey,
			attempt,
			hinted,
			lineWalkStep: isLineWalkStep,
			phase
		};
		// Hinted: the user plays the arrow (deriveOutcome → 'peeked').
		const outcome: DrillOutcome = hinted ? 'peeked' : answer(p) ? 'correct' : 'wrong';
		const before = (await getCard(seg.rep.id, card.fenKey)) ?? card;
		const after = grader.grade(
			key,
			card,
			outcome,
			{ isLineWalkStep, isMistakeReview, isIntroductionPass },
			params,
			now
		);
		if (after) await upsertCard(after);
		events.push({ ...p, outcome, before, after });
		if (seg.mode === 'retrain' && outcome === 'correct') {
			await markMistakeByPosition(seg.rep.id, card.fenKey);
		}
		return { outcome, isIntroductionPass, isLineWalkStep };
	};

	for (let s = 0; s < segments.length; s++) {
		const seg = segments[s];
		const lineWalkMode = seg.mode === 'due' && seg.walkStarts.length > 0;
		const drilled = new Set<string>();

		if (lineWalkMode) {
			const walkEnd = (w: number) =>
				w + 1 < seg.walkStarts.length ? seg.walkStarts[w + 1] : seg.cards.length;
			const drilledByWalk = new Map<number, Set<string>>();
			const failedByWalk = new Map<number, Set<string>>();
			const pendingTrain: number[] = [];

			const runWalk = async (w: number, phase: 'learn' | 'train' | 'retry') => {
				for (let i = seg.walkStarts[w]; i < walkEnd(w); i++) {
					const card = seg.cards[i];
					const key = ck(s, card.fenKey);
					if (drilled.has(key)) continue;
					const wasNew = !card.lastReview && !introduced.has(key);
					const { outcome } = await present(s, card, phase, true);
					if (outcome === 'wrong' && phase === 'learn') {
						const set = failedByWalk.get(w) ?? new Set<string>();
						set.add(card.fenKey);
						failedByWalk.set(w, set);
					}
					if (wasNew && phase === 'learn') introduced.add(key);
					drilled.add(key);
					const set = drilledByWalk.get(w) ?? new Set<string>();
					set.add(key);
					drilledByWalk.set(w, set);
				}
			};

			// Learn pass per walk (moveToWalk / maybeOpenWalkAt / advanceQueue).
			for (let w = 0; w < seg.walkStarts.length; w++) {
				for (const k of seg.walkFenKeys[w]) drilled.delete(ck(s, k));
				await runWalk(w, 'learn');
				const needsTrain = [...seg.walkFenKeys[w]].some((k) => introduced.has(ck(s, k)));
				if (needsTrain) pendingTrain.push(w);
			}
			// Segment tail (progressSegmentTail): deferred Train passes…
			for (const w of pendingTrain.sort((a, b) => a - b)) {
				for (const k of drilledByWalk.get(w) ?? []) drilled.delete(k);
				drilledByWalk.delete(w);
				failedByWalk.delete(w);
				await runWalk(w, 'train');
			}
			// …then a retry of each failed walk's missed cards.
			for (const w of [...failedByWalk.keys()].sort((a, b) => a - b)) {
				for (const k of failedByWalk.get(w)!) drilled.delete(ck(s, k));
				await runWalk(w, 'retry');
			}
			continue;
		}

		// Non-walk segment (auto mode, mistakes, retrain): advanceQueue's
		// linear path with intro re-queue, wrong-answer prune + re-queue.
		const runQueue = async (queue: Card[], phase: 'queue' | 'leaves') => {
			let justRated: string | null = null;
			for (let i = 0; i < queue.length; i++) {
				if (i > 5000) throw new Error('drill session did not terminate');
				const card = queue[i];
				const key = ck(s, card.fenKey);
				if (drilled.has(key) || card.fenKey === justRated) continue;
				const { outcome, isIntroductionPass, isLineWalkStep } = await present(
					s,
					card,
					phase,
					false
				);
				justRated = card.fenKey;
				const willReDrill = isIntroductionPass || (outcome === 'wrong' && !isLineWalkStep);
				if (!willReDrill) drilled.add(key);
				if (isIntroductionPass) {
					introduced.add(key);
					queue.push(card);
				}
				if (outcome === 'wrong' && !isIntroductionPass && !isLineWalkStep) {
					if (seg.mode !== 'retrain') {
						// pruneDeeperInLine: drop later entries below the failed move.
						for (let j = queue.length - 1; j > i; j--) {
							const path = pathToFenKey(seg.nodes, seg.rep.rootFenKey, queue[j].fenKey);
							if (path?.some((e) => e.toFenKey === card.fenKey)) queue.splice(j, 1);
						}
					}
					queue.push(card);
				}
			}
		};
		await runQueue(seg.cards.slice(), 'queue');
		// Leaves cycle (tryStartIdeasOrLeaves → extendSegmentWithLeaves): due
		// mode, non-walk segments only, once per segment. Leaves are read
		// fresh from storage at this point, not from the segment snapshot.
		if (seg.mode === 'due') {
			const leaves = sortLeavesByLineOrder(
				await collectReplayLeafCards(seg.rep, seg.nodes),
				seg.rep,
				seg.nodes
			).cards;
			for (const c of leaves) drilled.delete(ck(s, c.fenKey));
			await runQueue(leaves, 'leaves');
		}
	}
	return events;
}

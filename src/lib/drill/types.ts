import type { Card, IdeaCard, Repertoire, RepertoireNode } from '$lib/types';

export type DrillMode = 'due' | 'mistakes' | 'retrain';

/**
 * One repertoire's contribution to a drill session. Built up-front by
 * `buildSegment` (or the mistake/retrain variants) and handed to
 * `<DrillRunner>` for play. The merged "Quick drill" stitches several of
 * these together; the per-repertoire drill runs exactly one.
 *
 * Walk metadata is stored in *segment-local* indices (relative to `cards`)
 * so each segment can be built independently and the runner translates to
 * its own flat-queue indices.
 */
export interface DrillSegment {
	rep: Repertoire;
	nodes: Map<string, RepertoireNode>;
	mode: DrillMode;
	/** Line-first ordered queue for this segment. */
	cards: Card[];
	/** Line-label per card fenKey (null = pre-anchor / orphan). */
	lineLabelByKey: Map<string, string | null>;
	/**
	 * Walk starts within `cards` (in `due`+line-walk mode). Empty array for
	 * non-walk-mode sessions and for mistake/retrain modes.
	 */
	walkStarts: number[];
	walkFenKeys: Set<string>[];
	/**
	 * FenKeys that came from the original FSRS-due selection (i.e. NOT
	 * line-walk prefix-only steps). A wrong answer at a key outside this set
	 * doesn't count as a real lapse.
	 */
	dueOriginalKeys: Set<string>;
	/** Idea cards to play at this segment's tail. Empty in non-due modes. */
	ideaQueue: IdeaCard[];
}

/**
 * Internal queue entry the runner walks: each card always carries its
 * segment back-pointer so rep-aware operations (chain, prune, scrub,
 * mistake-marking, idea-cards) consult the right `nodes` / `rep`.
 */
export interface DrillEntry {
	card: Card;
	segIdx: number;
}

export type { MoveQuality } from './grade';

export type DrillPhase =
	| 'loading'
	| 'empty'
	| 'intro'
	| 'pending'
	| 'correct'
	| 'wrong'
	| 'refuted'
	| 'idea-prompt'
	| 'idea-reveal'
	| 'done';

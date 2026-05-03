# Masters overlay — Phase 2 plan

Resume marker for the masters-baseline rollout. Phase 1 is shipped on this
branch (commits `09ac2b5`, plus the earlier space-control feat+fix commits).
Delete this file once Phase 2 lands.

## What's already in place (Phase 1)

- `src/lib/dossier/mastersBaseline.ts` — `buildMastersBaseline(classified, opts)`
  produces a `ClassifiedGame[]` of master games matching the user's repertoire,
  classified from the master playing the user's colour. Already feed-compatible
  with any existing dossier module that consumes `ClassifiedGame[]`.
- `src/lib/storage/mastersBaseline.ts` — `loadMastersBaseline()` /
  `saveMastersBaseline()` over the new `masters_baseline` IDB store.
- `src/lib/dossier/spaceControl.ts` — `buildSpaceControl(games, { comparison })`.
  When `comparison` is supplied, the opp-as-X aggregates come from the
  comparison pool instead of in-scan opposite-colour user games.
- `/dossier/space-control` page — `Compare against: [Peers | Masters]` toggle,
  Fetch baseline button with progress, refresh action, status panel.

## Phase 2 modules to wire (in priority order)

Each one already takes `ClassifiedGame[]`. The pattern is identical to
space-control: add an optional `comparison?: ClassifiedGame[]` to the
`buildXxx`/`analyseXxx` signature, source the "opp / peer" aggregates from
the comparison pool when provided, and add a per-module `Compare against`
control in the corresponding subpage.

### 1. Style axes by opening (`fingerprint.byOpening`)

- File: `src/lib/dossier/fingerprint.ts` (search for `byOpening`).
- The per-opening axis rows already render in `/dossier/+page.svelte` and
  `/dossier/opening-fit/+page.svelte`. UX: third column "vs masters" beside
  the existing "vs you" delta — tabular, no toggle needed.
- Caveat: only show the column for openings the user _chose_; for "faced"
  rows the masters comparison is misleading (master facing the same line
  played different responses than the user did).

### 2. Tension management

- File: `src/lib/dossier/tension*.ts` and `TensionManagementCard.svelte`.
- Tension release / creation rates per phase. Masters typically keep tension
  longer; a directional benchmark is genuinely informative here.
- UX: third column "masters" alongside the existing peer baseline, since
  the card already renders a comparison row.

### 3. Structure taste

- File: `src/lib/dossier/structureTaste.ts`.
- Top pawn structures by user; add a "masters in same opening" share next
  to each structure row. UX: third column.
- Watch the sample sizes — we have ~12 master games per opening, so 100+
  positions per opening but probably <30 per structure. Render `<10` as
  thin-sample placeholder.

### 4. Exchange propensity

- File: `src/lib/dossier/exchangePropensity.ts`.
- Trade-rate by material state. Masters trade differently when ahead vs
  behind. UX: third column.

### 5. Consensus alignment

- File: `src/lib/dossier/consensus.ts`.
- This one's a near-trivial change: the module currently queries the Lichess
  _Lichess_ explorer (crowd) for "what move did most people play here?".
  Switching the source to `'masters'` for an alternate "consensus with
  masters" view is one parameter change in `getExplorerStats`/`fetchExplorer`.
- UX: per-module switch (heatmap-ish, not tabular). Or render both
  alignments side by side.
- Note: consensus does NOT consume the masters-baseline `ClassifiedGame[]`
  — it lives off the Explorer API directly. So this one doesn't need the
  baseline-pool plumbing at all; just a source toggle.

## Phase 3: explicitly skip

These modules can't be meaningfully compared to masters. Don't bother.

- CP-loss-based modules (scorecard, blunder atlas, blunder timing, blunder
  causality, calculation depth, decision difficulty, defensive resource):
  masters' CP loss vs Stockfish is near zero everywhere; the diff has no
  spatial structure.
- Behavioural (time-of-day, session decay, recovery arc): no master data.
- Personal (FSRS retention, repertoire lint, progression, exemplars): not
  population-comparable.
- Endgame subtypes: thin samples blow up further at the per-family per-type
  intersection.

## Decision gate before starting Phase 2

After running Phase 1 against a real scan, judge whether the masters overlay
in space-control surfaced anything actionable. If the diffs were mostly
noise, abandon Phase 2 — peer comparison alone is enough. If the masters
overlay highlighted real differences, proceed in priority order above,
landing each module as its own commit so we can stop early if signal
plateaus.

## Open methodology questions

- **Sample-size disclosure**: every Phase 2 module needs to show master-game
  counts inline so readers don't over-interpret 12-game baselines.
- **Opening filter for tension/structure/exchange**: should these modules
  filter to only positions in openings the user actually plays, or use the
  full master pool? Probably the former — otherwise we're back to the
  position-distribution confound.
- **Refresh trigger**: today refresh is manual. Should it fire automatically
  when `targetsHash(classified)` differs from the stored hash (repertoire
  shift)? Cheap to add but might surprise users mid-scan.

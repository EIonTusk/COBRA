# COBRA

**Chess Opening Builder and Repertoire Analyzer.**

<p>
  <a href="https://www.buymeacoffee.com/EIonTusk">
    <img src="https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=&slug=EIonTusk&button_colour=5F7FFF&font_colour=ffffff&font_family=Lato&outline_colour=000000&coffee_colour=FFDD00" alt="Buy me a coffee" height="32" />
  </a>
</p>

> ⚠️ **Heads-up — this was vibe-coded.** Every line in this repo was written
> in an extended conversation with Claude. No human reviewed each commit for
> correctness line-by-line. Treat it as a hobby-grade tool that happens to
> work, not as battle-tested software. Contributions, bug reports, and
> "actually this is wrong" corrections are all very welcome.

COBRA is a chess opening trainer that lives in your browser. You build your
repertoire as a move tree, drill it with spaced repetition, step through
master games for ideas, and get an honest list of the positions where you've
been going wrong in your own games. Everything is stored locally —
nothing is uploaded anywhere.

Inspired by [chessbook.com](https://chessbook.com)

---

## Contents

1. [Getting started](#getting-started)
2. [Building your first repertoire](#building-your-first-repertoire)
3. [Drilling](#drilling)
4. [Sparring](#sparring)
5. [Tour — walking your whole tree](#tour)
6. [Reviewing master games (the Walkthrough)](#reviewing-master-games)
7. [Fixing your own mistakes](#fixing-your-own-mistakes)
8. [The Dossier — deep personal analytics](#dossier)
9. [Coverage — knowing what you're missing](#coverage)
10. [Analysing positions (explorer + engine)](#analysing-positions)
11. [Sharing and syncing](#sharing-and-syncing)
12. [Settings & shortcuts](#settings--shortcuts)
13. [Troubleshooting](#troubleshooting)
14. [Running it yourself (developer notes)](#running-it-yourself)
15. [Contributing](#contributing)
16. [License](#license)

---

## Getting started

### 1. Open the app

The repo auto-deploys to GitHub Pages on every push to `main`:

**<https://eiontusk.github.io/COBRA/>**

Open that URL in **Chrome, Edge, Brave, or any Chromium browser** on
Windows, macOS, Linux, or Android. An **"Install COBRA"** icon appears in
the address bar (or under ⋮ → "Install app") — click it and COBRA becomes
a standalone windowed app with a desktop shortcut, start-menu entry, and
offline support. No binaries, no installer, no signing warnings. Updates
pull in automatically on next launch.

On iOS / iPadOS, Safari's **Share → Add to Home Screen** does the same
thing.

> Firefox on desktop doesn't support PWA install. You can still use COBRA
> in a Firefox tab, but for a standalone window use Chrome/Edge/Brave.

If you'd rather run it yourself (self-host, local dev, or fork), see
[Running it yourself](#running-it-yourself) at the bottom.

### 2. (Recommended) Connect your Lichess account

Most of the useful features — opening explorer, autobuild, mistake scan,
masters walkthrough — need a Lichess API token. Two ways to provide one:

- **Sign in with Lichess** (easiest). _Settings → Connect Lichess_ runs
  a standard OAuth flow and stores the token locally. Revoke it any time
  from your Lichess preferences.
- **Paste a personal token manually**. Generate one at
  <https://lichess.org/account/oauth/token> (no scopes required), paste it
  into _Settings → Lichess token_, save.

Without a token you can still build repertoires manually and drill them —
the explorer panel will just show a setup message.

### 3. Install it to your home screen (optional)

It's a PWA, so your browser's "install app" / "add to home screen" option
will give you a dedicated window with offline support.

---

## Building your first repertoire

### Create it

**Home → New repertoire.** Pick:

- **Name** (e.g. "Italian as White").
- **Your side** — this matters: the trainer only drills positions where
  it's _your_ side to move. If you're building Black, the app waits for
  the tree's opponent moves before it adds drill cards for your replies.
- **Start from the standard position**, or from a custom FEN (helpful for
  studying specific structures like a King's Indian tabiya).

After you create it you land on the **edit page**. On the right is a board,
on the left are two panels: the current line's move list, and the Lichess
opening explorer.

### Add moves

There are several ways to put moves into the tree:

- **Click them on the board.** The simplest. Pick a piece, drop it on a
  square, the move gets added as a child of the current position. If the
  move already exists in the tree you just navigate into it.
- **Click them in the explorer panel.** Each row is a popular move with
  its win/draw/loss stats. Clicking a row adds that move to the tree and
  advances the board.
- **Jump to the start / an ancestor** with the move-list breadcrumb or by
  pressing **← (left arrow)** to go back one ply, **Home** to rewind to
  the root.
- **Annotate a move** with a Chess-Informant glyph (`!`, `!?`, `?!`, `?`,
  `??`) from the move context menu. Glyphs show up on the board during
  drills too.
- **Leave a comment** on any position. The comment surfaces in drills and
  in exports.

### Use the explorer to avoid blind spots

The explorer tells you which moves real players have actually tried at
your position and which ones you haven't prepared replies to yet. Each
row shows the move, Stockfish's eval (when the move overlaps the running
MultiPV), score %, the W/D/B bar, and a small icon classifying the
move:

| Icon          | Tag        | Meaning                                                                          |
| ------------- | ---------- | -------------------------------------------------------------------------------- |
| Crown         | `MAIN`     | Lichess recognises the move as a transition into a named ECO opening / variation |
| Flame         | `SHARP`    | A narrowness probe shows the line is genuinely forcing for several plies         |
| Gem           | `ELITE`    | Strong average rating vs. the position baseline                                  |
| Sparkles      | `SURPRISE` | Played more often than its reputation would suggest                              |
| AlertTriangle | `DUBIOUS`  | Popular but statistically bad                                                    |

Tags stack — a single move can carry `MAIN` + `SHARP` + `ELITE` at
once, since they measure different signals (canonical classification,
forcing character, who plays it). `DUBIOUS` and `SURPRISE` are
exclusive.

A small bookmark sits to the left of the move code when that move is
already in your tree. Hover any icon for the full tooltip.

Above the board you'll also see two helper buttons:

- **Jump to next missing** — walks the tree in order and stops at the
  first of your positions where the opponent has a common reply you
  haven't prepared for.
- **Jump to most important missing** — same, but ranks by total game
  count so you plug your biggest gap first.

### Autobuild a starter repertoire

If clicking moves one by one sounds tedious, _Home → **New repertoire** →
Autobuild_ will scaffold one for you:

- **Autobuild from your Lichess games.** Enter your username. The app
  downloads your recent games and folds their opening moves (up to a
  depth you choose) into a new repertoire. Great for cementing "what you
  actually play" as a baseline before you improve it.
- **Autobuild from the masters database.** The app walks the
  Lichess `/masters` explorer recursively. On your side it picks the
  single most popular move (canonical theory). On the opponent's side
  it fans out across the top few common replies. The result is a tight
  canonical tree plus the responses you actually need to prepare.
- **Autobuild in the style of a specific master.** Pick a titled player
  from the combobox (or type a Lichess username) when using the masters
  flow. The walk samples _their_ games instead of the whole masters DB,
  so you get Magnus's Sveshnikov, Hikaru's London, etc.
- **Autobuild from a FIDE player's broadcast games.** Search a FIDE-rated
  player by name, cap how many recent tournaments to scan, and the app
  pulls their games out of the Lichess broadcasts (live/classical OTB
  events) and folds them into a new repertoire. Handy for prepping
  against an opponent you know you'll face, or for shadowing a top
  player's current OTB choices rather than their online blitz habits.
- **Constrain by starting moves.** Type the moves as SAN (`1.e4 c5
2.Nf3 d6`) or click them onto a small embedded board. Autobuild will
  start its walk from that point.

Autobuild is never destructive — it creates a new repertoire, it won't
touch an existing one.

### Import a PGN

If you already have your lines as a PGN (from ChessBase, chess.com, a
book you've typed up, etc.), go to **Home → Import**. Paste or upload; the
importer walks every variation, including nested ones, and merges them
into one repertoire.

---

## Drilling

From a repertoire's dashboard: **Drill**. A session shows cards one at a
time — each card is a position where you need to play the move you
prepared.

### What you see

- **The board**, oriented from your side.
- **A pale arrow** appears when you press the hint key: first just the
  source square, then a full arrow to the destination.
- **A glyph on the landing square** after you move:
  - `!` (green) — correct.
  - `!?` (yellow) — playable but not your best.
  - `?!` (orange) — dubious.
  - `?` (red-orange) — a mistake.
  - `??` (deep red) — a blunder.

### How a try goes

1. The board animates the buildup to the card's position, then waits for
   you.
2. You play a move. If it matches _any_ of the replies you've recorded
   for this position (multi-answer is on by default), you get the green
   `!` and the app auto-advances.
3. If you're wrong, the piece flashes red, a glyph stamps on the landing
   square, and — if Stockfish rates the move a real blunder — the engine
   plays its refutation out on the board so you see _why_ it lost. Then
   the piece floats back to where it started and you try again.
4. After a correct move, the app plays the opponent's recorded reply and
   checks whether the resulting position is _also_ a drill card. If so,
   it chains straight into it without rebuilding from the root. This
   keeps you inside the line instead of teleporting between random
   positions.

### Hints

Press **H**, **Z** or **?** while waiting for a move:

- **First press** — the source square lights up.
- **Second press** — the full arrow to the destination appears.

Any hint costs you a rating downgrade (Hard instead of Good) but nobody
watches you peek.

### Ratings

The app picks a rating automatically:

- No wrong tries, no hints → **Good**.
- Used a hint → **Hard**.
- Wrong on first try → **Again**.

You can override to **Easy** during the auto-advance window by pressing
**4**. "Easy" means "trivial, space this out more".

### When the queue is empty

You'll see the _All caught up_ screen. Two buttons matter:

- **Train further** — reload the queue. Useful when you've added lines
  mid-session or you want another pass right now.
- **Retrain from scratch** — resets the FSRS state of _every_ card in the
  repertoire so everything is due immediately. Useful if you broke a
  habit and want to re-learn the whole tree from zero. Positions stay;
  only the schedule resets.

### Line walk (default)

When a card from late in a line is due, the drill walks each earlier
user move first instead of teleporting straight to the due position.
Prefix moves don't count towards FSRS — getting them right is a free
pass, getting them wrong replays the segment without a lapse. This
preserves move-sequence memory: you rehearse the line as a line, not as
isolated flashcards.

Already-graduated prefix and suffix moves are animated through rather
than drilled — controlled by the _Animate past well-learned moves_
threshold in Settings. You can disable line walks entirely with the
_Walk every move of a line_ toggle if you'd rather drill the due card
on its own.

### Quick drill (across every repertoire)

**Home → Drill** (or `/drill`) merges due cards from _all_ your
repertoires into a single session. White repertoires come first, then
black, so a session won't ping-pong between sides. The session cap and
daily-new-card cap apply to the merged total — so once today's quota
is spent, later repertoires drop out and you'll see them tomorrow.

### Special drill modes

- `?mode=mistakes` — queue cards you've recently gotten wrong.
- `?mode=retrain` — queue positions the mistake scanner picked up from
  your Lichess / chess.com games (see
  [Fixing your own mistakes](#fixing-your-own-mistakes)). Answering
  correctly here marks that specific mistake as _corrected_, so it
  stops nagging you on the dashboard.

---

## Sparring

From a repertoire's dashboard: **Spar**. Sparring is free-form play
against Stockfish from any position inside your builder tree, rather
than flashcard-style drilling.

- Pick a starting position (root, or any node you navigate to from the
  tree view in the sidebar) and the engine plays out against you from
  there.
- **Engine strength** is configurable — same Stockfish that powers the
  mistake scanner, so it's genuinely strong at the higher settings.
- Any move you play that's **not in your tree** is flagged as a
  _deviation_ live, with the prepared move shown as a green arrow.
- At session end you can **save deviations as mistakes** in one click.
  They land in the same `StoredMistake` store as the games-scan
  mistakes, so they surface on `/mistakes` and feed the same retrain
  drills.

This is where you pressure-test lines you _think_ you know — the engine
will try every transposition and sideline Lichess players would try, and
the app keeps the book honest about whether you actually recalled the
reply or just guessed.

---

## Tour

From a repertoire's dashboard: **Tour** (`/repertoire/[id]/tour`).

Tour walks your whole repertoire as a depth-first sequence: every line,
every branch, in order. At each position you see all of your candidate
moves as arrows, and you can step manually (←/→), autoplay at
slow/normal/fast, flip the board, or reveal the idea card for the
current node.

It's for:

- **Refreshing the entire tree by hand** before a tournament, without
  the random-order jumps of the drill queue.
- **Teaching** — load the repertoire on a second screen and narrate it
  end-to-end.
- **Sanity-checking** that the branches you've built actually flow into
  each other the way you think they do.

Ideas you've written on positions surface inline, so the tour doubles as
a readable walkthrough of _why_ you play what you play.

---

## Reviewing master games

The **Walkthrough** page (`/walkthrough`, or from the header) is for
studying games one ply at a time with the app telling you whether each
move matches your prep.

Three ways to load a game:

1. **Pick from the masters browser.** The page lists recent high-rated
   masters games. Click one to load it.
2. **Paste a PGN** straight into the text box.
3. **Paste a Lichess game URL or ID** — the app fetches the PGN for you.

As you step through (Left/Right arrow keys, or the on-screen buttons):

- **Match** — the played move is in your repertoire for that colour.
- **Deviation** — the played move is not in your tree. The app draws
  your _expected_ move on the board as a green arrow so you see what you
  would have played.
- **Past prep** — the line has gone beyond where you've built your tree.
  Useful as a prompt to extend your repertoire.

If you hit a deviation that looks important, you can jump straight from
the walkthrough into the edit page at that position.

---

## Fixing your own mistakes

**Home → Mistakes**, or `/mistakes`.

The mistake scanner pulls your recent ranked games and plays each one
against every repertoire you have for that colour. Any move where you
deviated from the tree's recommended reply — and the engine rates the
deviation as a real mistake — becomes a row.

### Sources

- **Lichess** — the OAuth-connected account (or a manual personal
  token), or any Lichess username you type in.
- **chess.com** — scanned via the public archives API, no token
  required. Just type the username and pick the chess.com toggle.

Deviations saved from a sparring session (see
[Sparring](#sparring)) land in the same list.

### Multi-account scanning

_Settings → Scan accounts_ lets you add any number of
Lichess + chess.com usernames. The dashboard's on-load scan and the
hourly auto-scan sweep every one (plus the OAuth-connected Lichess
account if any) and merge results. Per-account errors don't abort the
others, and dedup is by `(source, lowercased-username)`.

### Rows

Rows persist across sessions. Each one shows:

- The game, the move you played, the move you'd prepared.
- A severity badge (based on Stockfish's centipawn loss).
- A source icon (Lichess or chess.com) so you can see which platform
  the mistake came from.
- A _Retrain_ link that opens a drill session seeded with exactly that
  position.

If you've connected at least one account, a background scan runs
roughly hourly to keep the list fresh. You can also trigger a manual
rescan from the page.

When you answer the position correctly in retrain mode, the mistake is
marked _corrected_ and drops off the list automatically.

### Opponent prep

**Home → Opponent prep**, or `/opponent-prep`. Pulls a specific Lichess
player's recent games, walks each one against the repertoire you pick,
and surfaces the opponent moves _at every level_ that your tree
doesn't answer yet — ranked by how often the opponent plays them.
Click a gap to jump straight into the editor at that position with the
prep walk pre-loaded so you can fill them in one after another. Useful
the night before a game against someone whose Lichess handle you know.

---

## Dossier

**Home → Dossier**, or `/dossier`.

The Dossier is a forensic self-analysis report built from your own
games. Where _Mistakes_ flags individual blunders, the Dossier looks
for _patterns_: what kinds of positions break you, what kinds suit you,
when in a game (and when in the day) you leak Elo, and what to drill
first if you have an hour this week.

### What it does

Pick one or more of your configured accounts (Lichess + chess.com),
cap the number of recent games, pick an engine depth, and scan. The
report is written to IndexedDB and rendered as a single dashboard page
with ~two dozen drill-down subpages. Re-running the scan updates the
report in place. You can also load a shared report someone sent you
(see [Sharing and syncing](#sharing-and-syncing)).

The home page of the dossier shows:

- An overall style fingerprint vs. a shipped baseline of typical
  players at similar rating / speed, with highlighted axes where you
  land far from the median.
- A Level-up card naming the one axis likely to move your rating most.
- A Fix-first card: the handful of concrete positions where a drill
  session would pay off most right now.
- A narrative arc of your last N games written out in plain English.

### Subpages

Each subpage is a standalone analysis with its own chart and, where
relevant, a "drill these" button that seeds a retrain session with the
positions you keep losing to.

- **Narrative** — prose arc of your recent games.
- **Consensus alignment** — how closely your moves match theory in
  your prepared openings.
- **Opening fit** — which structures suit the style you actually play.
- **Structure taste** / **Plan taste** / **Exchange propensity** /
  **Piece affinity** — your revealed preferences vs. the
  population.
- **Tactical motifs** — which motifs you miss most.
- **Calculation depth** — how many plies deep your strongest decisions
  tend to go.
- **Defensive resource** / **Prophylaxis** — defensive and preventive
  play scores.
- **Blunder timing** — in which phase of the game (opening / middle /
  endgame) you bleed Elo.
- **Endgame subtypes** — which endgame families (R+P, minor, opposite
  colours, …) trip you up.
- **Time of day** / **Session decay** — performance against the clock
  and against fatigue within a session.
- **Repeat offenders** — positions you keep returning to and keep
  getting wrong.
- **Recovery arc** — whether you come back or tilt after a blunder.
- **Opponent strength** — how your play scales with opponent rating.
- **Exemplars** — your best games, as model positions to study.
- **Progression** / **Level up** — month-over-month change, and the
  single axis the report thinks is most worth working on.
- **Fix first** — ranked list of concrete positions to drill first.

### Baselines

The report benchmarks you against a baseline of typical players for
your rating / speed combination. A calibrated baseline ships with the
app (`src/lib/dossier/baseline.json`, rebuilt by
`scripts/compute-dossier-baseline.mjs`). You can also **self-calibrate**
a personal baseline from _Settings_ by running the scan across your own
accounts and storing the empirical stats, which then override the
shipped defaults on the dossier's headline indices.

Running the scan costs a few minutes of wall clock and some Lichess /
chess.com API quota, so the report is cached and only recomputed when
you ask it to.

---

## Coverage

How much of what real opponents actually play have you prepared a reply
to? That's coverage.

From a repertoire's dashboard you can set a **coverage goal**:
`1 in 200 games`, `1 in 500`, etc. The number means "I want to be
prepared for all opponent moves that show up at least this often".

Once a goal is set:

- The dashboard shows a progress meter — fraction of explorer-reachable
  opponent moves at-or-above the threshold that you've answered.
- The edit page's **Jump to next missing** / **Jump to most important
  missing** buttons become laser-focused on positions below the
  threshold.

Coverage is computed lazily (it uses cached explorer probes), so browsing
repertoires stays snappy.

---

## Analysing positions

On the edit page, alongside the board:

- **Candidates panel** (powered by the Lichess explorer) with per-move
  stats, an overlaid Stockfish eval on any move that overlaps the
  engine's running MultiPV, and — when Lichess has no games for the
  position — a fallback list of engine-only suggestions. Clicking a
  row adds that move to your tree.
- **Inline engine readout** under the action row. Stockfish starts
  automatically and shows the live eval + top move in plain text. The
  toggle here only controls whether its suggestions are painted on
  the board (engine arrows for the top 6 MultiPV, plus pale blue
  arrows for explorer-popular moves you haven't prepared). The engine
  evaluates both your move and your opponent's so you can audit
  either side of the tree.
- **Copy line**. A small quiet copy button in the corner of the Line
  card drops the current line on the clipboard in standard
  `1. e4 e5 2. Nf3 …` form.

---

## Sharing and syncing

Everything COBRA knows lives in your browser, but that doesn't mean you
can't hand a repertoire to someone else or sync it into a Lichess
study.

### Share a repertoire by link

From a repertoire's dashboard, open the ⋯ menu and pick **Share as
link**. The app builds a gzipped base64 bundle of the repertoire, every
node, every move card, and every idea card, and drops it into a URL
fragment (`/import-share#data=…`). Paste the link to anyone — the data
travels in the URL, nothing is uploaded.

The recipient opens the link and lands on a preview showing repertoire
name, colour, node count, and card counts. Clicking **Import** creates
a fresh copy under a new UUID, so sharing can never overwrite the
recipient's local prep. FSRS state is reset on import so the receiver
starts learning the tree from zero.

You can share a Dossier report the same way — the `/dossier` page has a
_Share report_ button that encodes the scan result into a viewable
link.

### Sync a repertoire with a Lichess study

From a repertoire's dashboard: **Lichess sync**
(`/repertoire/[id]/lichess-sync`). This is two-way sync against a
private (or public) Lichess study:

- **Push** — write your COBRA tree to a study as chapters, one per
  mainline branch. Create a new study or attach to an existing one.
- **Pull** — read a study back in as a repertoire, following every
  chapter and every variation.

Because Lichess studies require scoped OAuth for writes, this feature
only works once you've connected Lichess via OAuth with the study
scopes. A personal API token alone isn't enough.

The link between a repertoire and its study is remembered, so
subsequent pushes / pulls are one click.

---

## Settings & shortcuts

### Settings

- **Lichess connection** — OAuth button, or paste a personal token.
  OAuth is required for Lichess-study sync (study scopes); the mistake
  scanner and explorer work with either.
- **Scan accounts** — add any number of Lichess and chess.com
  usernames to fold into the hourly mistake scan and the dossier scan.
- **Calibrate baseline** — run a dossier scan across your accounts and
  store the empirical stats as a personal baseline for the dossier's
  headline indices.
- **Drill pace** — how long the auto-advance waits after a correct
  answer.
- **Session cap** — maximum cards per drill session.
- **Intro animation speed** — how fast the board plays the buildup to
  each card. `Off` jumps straight to the position.
- **Walk every move of a line** — toggle line-walk mode. On (default)
  the drill walks every earlier user move before the due card; off
  drills the due card directly.
- **Animate past well-learned moves** — stability threshold (in days)
  above which line-walk prefix/suffix moves play out as animation
  rather than as drill cards.
- **Appearance** — board theme + piece set. The choice applies to
  every board in the app; click a tile to preview, _Save_ to commit.
- **Explorer filters** — time controls, rating buckets.
- **FSRS parameters** — for the curious. Defaults work fine.
- **Export library** — downloads a single JSON containing every
  repertoire, every position, every card, and your settings. Keep it as
  a backup.
- **Import library** — restores from that JSON. **Destructive — wipes
  your current data.** Always export first.

### Keyboard shortcuts

| Where           | Key             | What it does                           |
| --------------- | --------------- | -------------------------------------- |
| Drill (waiting) | `H` / `Z` / `?` | Progressive hint (source → full arrow) |
| Drill (correct) | `4`             | Override rating to _Easy_              |
| Edit page       | `←`             | Go back one ply                        |
| Edit page       | `Home`          | Rewind to the root                     |
| Walkthrough     | `←` / `→`       | Step through plies                     |
| Walkthrough     | `Home` / `End`  | Jump to start / end                    |
| Settings        | `Ctrl/Cmd + S`  | Save                                   |

---

## Troubleshooting

- **"Lichess explorer requires a personal API token."**
  Connect Lichess in settings, or paste a token. The explorer endpoint
  started requiring auth in 2026.
- **No Stockfish / no engine refutations.**
  The WASM bundle isn't bundled in by default. If you're running the app
  yourself, `npm run prep:stockfish` (≈20 MB NNUE download) installs it.
  Without it, everything except the engine panel still works.
- **"Rate-limited by Lichess"** during autobuild or a mistake scan.
  The app automatically backs off for 60 seconds. Just wait.
- **Drill feels wrong after you imported a huge PGN.**
  New positions start with a fresh FSRS state, so they'll all be due at
  once. Either bump the session cap, or use _Retrain from scratch_ to
  normalise schedules after a big import.
- **I lost my data after clearing browser storage.**
  Local-only means local-only — there's no server. Export the library
  regularly if the data matters to you.

---

## Running it yourself

```bash
npm install
npm run prep:stockfish   # downloads Stockfish WASM + NNUE to static/stockfish/
npm run dev              # open http://localhost:5173
```

### Build

```bash
npm run build
npm run preview
```

Serve `static/_headers` (or equivalent host config) so the COOP/COEP
headers land — required for threaded Stockfish via `SharedArrayBuffer`.

**Cloudflare Pages:**

- Build command: `npm run prep:stockfish && npm run build`
- Output directory: `build`
- Node version: 22+

### Tests

```bash
npm run check            # type-check
npm run test:unit        # Vitest
npm run test:e2e         # Playwright (builds first)
```

### Stack

SvelteKit 2 + Svelte 5 (runes), TypeScript strict, Tailwind 4,
[`@lichess-org/chessground`](https://github.com/lichess-org/chessground)
for the board, [`chessops`](https://github.com/niklasf/chessops) for
rules, [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs) for
scheduling, [`idb`](https://github.com/jakearchibald/idb) for storage,
[`lila-stockfish-web`](https://github.com/lichess-org/lila-stockfish-web)
for the engine, [`@vite-pwa/sveltekit`](https://vite-pwa-org.netlify.app)
for the service worker.

### Data model

FEN-keyed graphs: each position is one node, move orders that reach the
same position share a node. Transpositions just work — you can't
accidentally duplicate-drill them.

IndexedDB stores: `repertoires`, `nodes`, `cards`, `idea_cards`,
`settings`, `explorer_stats`, `mistakes`, `empirical_gaps`, `baselines`,
`style_reports`, `dossier_scan_checkpoint`, `spar_games`, `position_wdl`.
Schema is at v15; migrations are additive.

---

## Contributing

PRs, bug reports, and corrections are very welcome — this is a hobby
project and every extra pair of eyes helps.

### Before you open a PR

Run the full local gate. CI runs the same checks, so catching failures
here saves a round-trip:

```bash
npm run check:versions   # verifies package.json / tauri / manifest versions align
npm run check            # svelte-kit sync + svelte-check (type-check)
npm run lint             # prettier --check + eslint
npm run test:unit -- --run
npm run test:e2e         # Playwright — only if your change touches UI flows
```

If `npm run lint` flags formatting, `npm run format` rewrites the
offending files with Prettier. Don't hand-edit around it.

### Commit and PR guidelines

- **One logical change per PR.** Refactors, feature work, and unrelated
  cleanups belong in separate PRs — it keeps review tractable.
- **Conventional-ish commit messages.** Look at `git log` for the house
  style (`fix(ci): …`, `feat(drill): …`). Nothing strict, just readable.
- **Describe the user-visible change** in the PR body, plus anything a
  reviewer would otherwise have to dig for (why the approach, what you
  considered and rejected, test plan).
- **Don't commit generated artifacts** (`build/`, `static/stockfish/`,
  dossier baseline rebuilds unless that's the point of the PR).
- **Target `main`.** There are no long-lived branches.

### What's especially welcome

- Reproductions and fixes for "this drill behaviour looks wrong"
  reports.
- Dossier subpage improvements — the analytics heuristics are rough and
  calibration data is limited.
- Accessibility and keyboard-navigation fixes.
- Docs corrections. If something in this README is wrong or stale,
  please fix it in the same PR as the code change that made it stale.

---

## License

**AGPL-3.0-or-later.** See [LICENSE](LICENSE).

This project links against chessground (GPL-3.0), chessops (GPL-3.0),
and lila-stockfish-web (AGPL-3.0). AGPL-3.0 is the strongest of the
three, so the whole project adopts it. Forks, contributions, and
self-hosting are all welcome; running a modified version for other users
requires publishing your modifications.

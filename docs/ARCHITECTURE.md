# How kaizen works

Hand-written companion to the generated [LIFECYCLE.md](LIFECYCLE.md). That file
describes the _model_ (phases, statuses, transitions); this one describes the
_machine_ — what runs where, what each module owns, and which invariants hold
the thing together. The README covers the why; start there if you haven't.

## The loop, end to end

1. **Capture.** A skill finishes a run and, following `skills/_lib/skill-reflect.md`,
   writes a markdown file into a feedback directory
   (`<feedback>/<skill-name>/<date>-<slug>.md`). Kaizen is not involved — the
   file format predates it, and the parser tolerates files written before any
   given field existed.
2. **Session line.** A `SessionStart` hook (`hooks/session-status.sh`) runs
   `kaizen status`: one line, no model, silent when there is nothing to say.
   `kaizen status --bar` is the same piles as glyphs, for a status line. Both
   count open work only — a closed suggestion is history, and a skill whose
   suggestions are all applied or superseded is not named. One `piles()` in
   `scripts/cli.mjs` answers for both; the glyphs and their meanings are spec
   data (`statusLine` in `lifecycle.json`), so the TUI's guide explains exactly
   what the bar paints.

   The same hook is where the **weekly pass** fires, when `asks.enabled` is on
   and the `cadence.weekly` slot has gone by. That pass covers what step 1
   structurally cannot see: capture is driven by friction, so an ask that goes
   smoothly twenty times files nothing. `kaizen asks --json` hands the redacted
   prompt log — plus `known`, the slugs already filed, so dedup is an input
   rather than an instruction — to a detached `claude -p`, which follows the
   "Recurring asks" section of the triage skill and files ordinary suggestions
   under `skill: session`. From there they are indistinguishable from any other
   suggestion — same grouping, same queue.

3. **Triage / plan.** An `opencode` run (the `skills/kaizen/SKILL.md` skill in
   its `run` mode) reads the state, confirms each problem still exists at HEAD,
   labels it, and writes real patches plus validation plans — every status it
   sets flagged `needs_review: claude`. All file edits go through the CLI/server,
   never by hand-editing status fields the model forbids.
4. **Check.** A `claude` run (the same skill in `review` mode) takes every
   flagged card and clears the flag, or sends the card back one status and
   parks it on you with the reason. Until it clears, the card sits in the
   board's `review` lane and no key can approve it.
5. **Decide.** The only attended phase. `kaizen tui` — `a` advances the
   selected card (here, that is your yes), `A` the whole planned lane.
6. **Apply.** The server lands each approved patch as one commit with a
   `Kaizen-Suggestion:` trailer, closes the cards that were parked on it
   (`blocked_on` naming the lead — never a card that merely shares the file),
   and puts the card in line for its review. A patch that cannot land parks
   the card with git's reason instead of failing the same way tomorrow; `a`
   on any parked card opens its ways out (a new plan, an answer, another
   target, out), and `approved → triaged` is the edge a send-back takes.
   `git log --grep=Kaizen-Suggestion` is the ledger; `git revert` is the undo.
7. **Review, then verify.** opencode reads the commit against the plan, runs the
   validation plan and writes `## Review`; claude runs it again and says whether
   the loop closed. Only then is the suggestion terminal.

## Repo layout

| Path                                     | What it is                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `lifecycle.json`                         | The single source for phases, statuses, transitions, fields, rungs                                             |
| `packages/core`                          | `@kaizen/core` — the engine. Plain Node, zero dependencies                                                     |
| `packages/server`                        | `@kaizen/server` — `node:http` API on loopback + SSE file watching                                             |
| `scripts/cli.mjs`                        | The one entry point: `init scan status validate triage verify drain asks doctor docs prune serve dispatch tui` |
| `tui/`                                   | Rust/ratatui front end over the API                                                                            |
| `skills/kaizen`                          | The triage skill (`/kaizen:triage`)                                                                            |
| `skills/_lib`                            | `skill-reflect.md`, the capture convention skills follow                                                       |
| `commands/`, `hooks/`, `.claude-plugin/` | Claude Code plugin surface                                                                                     |
| `docs/LIFECYCLE.md`                      | Generated from `lifecycle.json` — never edit by hand                                                           |

User state lives outside the repo: config in `~/.claude/kaizen/config.json`
(`KAIZEN_CONFIG` overrides, which is how the tests isolate themselves),
suggestions in the configured feedback directories, and beside the config the
dispatch seat and its line (`dispatch.json`) so a server restart neither drops
the queue nor loses the run still going. Nothing user-specific is checked in.

Dispatch is `dispatch.maxAgents` seats and a line: fenced runs go in parallel
up to that many, a request with no seat free queues, each seat hands itself on
when its run exits, and each entry is re-gated when its turn comes. A backlog
run always runs alone — it walks every card, so it cannot share the corpus with
a fenced run without two agents writing one file. With `dispatch.auto` on, a
new arrival in a feedback directory is a backlog run without a key — gated on
newcomers, so a card the pass parks does not re-trigger a run every time a seat
frees.

Two runners take the seats, and the spec says which: each phase names a
`runner` (`opencode` does triage, plan and the post-apply review; `claude`
verifies) and, where the runner's output is provisional, a `reviewer`. The
server picks the binary from the card — `runnerOf`: the name on `needs_review`
if set, else the next phase's runner — and for the backlog sends a reviewer
first while anything is flagged. `dispatch.models` is what each is started
with. Runs chain: a run that exits 0 and leaves a `(card, runner)` pair that was
not pending when it started puts its own key back in line, so one `a` is the
whole unattended stretch — opencode plans and flags, claude checks — and a run
that produced nothing new, or died, chains nothing. The check is a third gate
on status writes: a card wearing `needs_review` cannot move forward, from a key
or a sweep, until the reviewer clears it.

`blocked_on` carries two different waits, so `buildState` derives `blockedBy`:
the open suggestion the block names, if it names one. A card waiting on another
card parks in the `blocked` lane — no key of the user's moves it. A card waiting
on the user stands in its own lane with the flag lit, where the key that moves
it already is, and `b` is how the user answers or clears it. The distinction is
data, not a reading of the sentence, and it goes stale on its own: `blockedBy`
empties when the card it names closes.

The dispatch gate is `pendingPass`, not the status alone: a card whose
frontmatter carries `blocked_on` is parked on something outside the pipeline —
a carrier patch, a read-only target, a file only the user can move — and a run
fenced to one can do nothing but re-stamp `confirmed_at`. It is refused with a
422 quoting the block, left out of the backlog count and out of auto-dispatch's
newcomer set, and refused by the TUI before the request is even sent. The field
already says why; paying a model call to rediscover it is the cost this avoids.

## @kaizen/core — the engine

Each module owns one thing; `index.mjs` is the public surface.

- **`config.mjs`** — load/validate/save. Defaults are computed, `targets` starts
  empty (`kaizen init` fills it per machine). Validation refuses contradictions
  (empty surface lists, non-loopback hosts) rather than interpreting them.
- **`taxonomy.mjs`** — the closed vocabularies (`TYPES`, `OBJECTIVES`, `EFFORTS`,
  `SEVERITIES`) and the `surface` predicate. Import-free on purpose: it breaks
  what would otherwise be a config↔suggestion cycle.
- **`suggestion.mjs`** — parse one feedback file: hand-rolled flat frontmatter,
  `## Recurrence` counting, `score = impact × (1 + recurrences) / effort`.
  Untriaged scores 0 so it sorts below anything assessed. `writeFrontmatter`
  rewrites keys in place, preserving order and body.
- **`scan.mjs`** — `buildState(config)` reads the world: skills (in place, never
  copied), suggestions, orphans, metrics. Collapses git worktrees via
  `--git-common-dir` so one repo's skills count once. Tags each suggestion
  `surfaced` (a view preference — nothing is dropped from the state).
  `assignBlockedBy` is exported separately: the status bar needs to know whether
  a block waits on another card or on you, and cannot afford a full scan.
- **`lifecycle.mjs`** — loads and validates `lifecycle.json`, answers every
  status question (`isTerminal`, `canTransition`, `hasLanded`,
  `awaitingDecision`, `nextPhase`, `runnerOf`, `pendingPass`,
  `missingRequirements`…), carries the status-line legend (`statusLine`,
  `pileGlyph`), and renders `docs/LIFECYCLE.md`. `nextPhase` reads `next` in
  order, because a status can go back now and the forward edge is listed first.
  Everything is _derived_ from the spec, never listed by name — that is the
  whole defence against a renamed status silently breaking a filter.
- **`paths.mjs`** — path containment. Every caller-supplied path is resolved
  through symlinks and asserted inside a configured target. Suggestion ids are
  strictly `<target>/<skill>/<file.md>`.
- **`asks.mjs`** — the prompt log as a corpus, plus the weekly schedule that
  decides when to read it. Redacts URLs and paths, windows to `asks.days`, drops
  `/` and `!` lines, collapses exact repeats. It deliberately groups nothing:
  over 5,556 real prompts the top repeated 3-grams were all URL and
  home-directory fragments — the same wall the old clusterer hit. Off
  unless `asks.enabled` — the file is everything the user has ever typed.
  `windowDays` gives the first pass the full backlog and every later one only
  what has happened since the last stamp plus a lookback, so a pass never spends
  tokens re-judging what is already on disk.
- **`doctor.mjs`** — kaizen's rubric applied to kaizen itself. Each check
  encodes a defect once found by hand; findings are suggestion-shaped so
  `--file` queues them with everything else.

## @kaizen/server — the API

A small route table plus `GET /api/events` (SSE), `node:http`, bound to
`127.0.0.1` — that binding **is** the security boundary, because these routes
write files and shell out to git.

| Route                                  | Does                                                                                                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/state`                       | `buildState(config)`                                                                                                                                                                                                                           |
| `GET /api/config` / `POST /api/config` | read / validate-then-save (restarts watchers)                                                                                                                                                                                                  |
| `GET /api/skill?path=`                 | raw markdown, containment-checked                                                                                                                                                                                                              |
| `GET /api/diff?id=`                    | the sibling `.patch`, if any                                                                                                                                                                                                                   |
| `POST /api/suggestion`                 | one status move, gated (see below)                                                                                                                                                                                                             |
| `POST /api/sweep`                      | one status move for all — moves the movable                                                                                                                                                                                                    |
| `POST /api/dispatch`                   | one detached run, opencode or claude by the card — one id, or the backlog; queues behind a live one                                                                                                                                            |
| `GET /api/dispatch/log`                | the tail of the triage log, last 200 lines                                                                                                                                                                                                     |
| `POST /api/apply`                      | `git apply` + one commit + writes `applied` + sha; closes the cards carried by it; queues the review. A patch that cannot land parks the card (`blocked_on: apply: …`, `parked: true` in the 422); a tree that is not ready is a plain refusal |
| `POST /api/unblock`                    | one of a parked card's ways out — `replan`, `clear`, `answer`, `supersede`, `reject`, `retarget` — composed from the same gated writes a key makes; what the user typed lands under `## Answer`                                                |
| `POST /api/revert`                     | `git revert` a kaizen commit on a writable target                                                                                                                                                                                              |

Every status write passes three gates: the transition must be legal in the
spec, the card must not be waiting on a check (`needs_review`) unless the move
is the way out, and the destination phase's `requires` must already be present
in the file (patch on disk, sections non-empty). `applied` is server-owned —
only the code that saw the sha may write it. Apply additionally requires a
writable target, a clean tree, and `git apply --check`. Approval stamps the
SHA-256 identity of the sidecar bytes; apply refuses if the sidecar no longer
matches, and regenerating it returns the card to planning and review.

`events.mjs` watches only the feedback directories (not skills trees — apply
commits there would fire a storm; not scan roots — unbounded) and pushes
debounced SSE `change` events. Watchers start with the first subscriber and
stop with the last.

## The TUI

`kaizen tui` starts the server itself if the port is dead. Rust embeds
`lifecycle.json` at compile time (`include_str!`), so filters, abbreviations
and the `D` docs overlay work with the server down.

- `api.rs` — HTTP client, types, the SSE reader.
- `tui.rs` — app state, key dispatch, the detail window (its facts are `label
value`, three to a row, so reading a card does not need the vocabulary in your
  head first; `enter` opens a card
  whole in an overlay, held by id so a refresh cannot swap it), the header
  spinner (a frame counter bumped by the event loop's tick).
- `keys.rs` — every binding declared once; the help card and footer are built
  from the same table, so a key cannot be documented one way and bound another.
- `views/` — board (the main view: a lane per pipeline stage, all spec-derived;
  the stages stay visible even empty and each lane is subtitled with the phase
  it waits for and whose move it is, while loop-back lanes collapse; past the
  stages sit the three lanes a card _waits_ in rather than holds — `review`
  while a status the runner wrote waits on its check, `blocked` while its
  `blocked_on` names another card, `closed` for the terminals; a run moves
  nothing, the card keeps its lane and wears the mark (spinner, place in line,
  `◌`); `review` stands even when empty, because a column that appears under
  you shifts every lane to its right; lanes wrap onto a second band instead of
  scrolling off the right, so the whole board is one glance; decide/apply keys
  act on the selected card, and `b` writes or clears what a card is waiting
  on), agents (every run going — who has it, target, pid, age — the last few
  that ended with their exit code, and the line waiting for a seat; the log
  itself stays in `~/.claude/kaizen/dispatch.log`), skills
  (failures per 100 lines of prose, worst first), settings (edit via `$EDITOR`,
  server validates).
- `theme.rs` — one palette; `lifecycle.rs` — the embedded spec and its queries.

The boundary that matters: **the engine decides, the TUI draws.** Every derived
fact a view needs is computed in core or read from the spec; the front end has
nothing to re-derive and nothing to disagree with.

## Invariants — and what to run after touching them

- `lifecycle.json` is the only copy of the model. After editing it:
  `npm run docs` (regenerates LIFECYCLE.md) and `cargo test` in `tui/` (the
  embedded copy is the same file, but its tests assert spec validity).
- `npm run check` = docs freshness + prettier + eslint + vitest, in that order.
  CI-equivalent; run it before calling anything done.
- `@kaizen/core` has zero runtime dependencies. Keep it that way.
- The server binds loopback only; `validateConfig` refuses anything else.
- Nothing applies without an approval of those exact patch bytes, and `git revert` must always be a clean
  undo — that is what the clean-tree guard protects.
- `kaizen doctor` is the self-review; its findings queue like any suggestion.

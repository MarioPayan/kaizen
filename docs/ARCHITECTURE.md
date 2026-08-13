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
   `kaizen status`: one line, no model, silent when there is nothing to say. It
   counts open work only — a skill whose suggestions are all applied or
   superseded is history and is not named.

   The same hook is where the **weekly pass** fires, when `asks.enabled` is on
   and the `cadence.weekly` slot has gone by. That pass covers what step 1
   structurally cannot see: capture is driven by friction, so an ask that goes
   smoothly twenty times files nothing. `kaizen asks --json` hands the redacted
   prompt log — plus `known`, the slugs already filed, so dedup is an input
   rather than an instruction — to a detached `claude -p`, which follows the
   "Recurring asks" section of the triage skill and files ordinary suggestions
   under `skill: session`. From there they are indistinguishable from any other
   suggestion — same grouping, same queue.

3. **Triage / plan.** `/kaizen:triage` (the `skills/kaizen/SKILL.md` skill) reads
   the state, confirms each problem still exists at HEAD, labels it, and writes
   real patches plus validation plans. All file edits go through the CLI/server,
   never by hand-editing status fields the model forbids.
4. **Decide.** The only attended phase. `kaizen tui` — approve per suggestion
   (`a`) or per skill (`A`).
5. **Apply.** The server lands each approved patch as one commit with a
   `Kaizen-Suggestion:` trailer. `git log --grep=Kaizen-Suggestion` is the
   ledger; `git revert` is the undo.
6. **Verify.** The validation plan written in step 3 runs against what actually
   landed. Only then is the suggestion terminal.

## Repo layout

| Path                                     | What it is                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `lifecycle.json`                         | The single source for phases, statuses, transitions, fields, rungs                 |
| `packages/core`                          | `@kaizen/core` — the engine. Plain Node, zero dependencies                         |
| `packages/server`                        | `@kaizen/server` — `node:http` API on loopback + SSE file watching                 |
| `scripts/cli.mjs`                        | The one entry point: `init scan status validate triage asks doctor docs serve tui` |
| `tui/`                                   | Rust/ratatui front end over the API                                                |
| `skills/kaizen`                          | The triage skill (`/kaizen:triage`)                                                |
| `skills/_lib`                            | `skill-reflect.md`, the capture convention skills follow                           |
| `commands/`, `hooks/`, `.claude-plugin/` | Claude Code plugin surface                                                         |
| `docs/LIFECYCLE.md`                      | Generated from `lifecycle.json` — never edit by hand                               |

User state lives outside the repo: config in `~/.claude/kaizen/config.json`
(`KAIZEN_CONFIG` overrides, which is how the tests isolate themselves),
suggestions in the configured feedback directories. Nothing user-specific is
checked in.

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
- **`lifecycle.mjs`** — loads and validates `lifecycle.json`, answers every
  status question (`isTerminal`, `canTransition`, `hasLanded`,
  `awaitingDecision`, `missingRequirements`…), and renders `docs/LIFECYCLE.md`.
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

| Route                                  | Does                                               |
| -------------------------------------- | -------------------------------------------------- |
| `GET /api/state`                       | `buildState(config)`                               |
| `GET /api/config` / `POST /api/config` | read / validate-then-save (restarts watchers)      |
| `GET /api/skill?path=`                 | raw markdown, containment-checked                  |
| `GET /api/diff?id=`                    | the sibling `.patch`, if any                       |
| `POST /api/suggestion`                 | one status move, gated (see below)                 |
| `POST /api/group`                      | one status move per skill — moves the movable      |
| `POST /api/dispatch`                   | one detached `claude` run — one id, or the backlog |
| `POST /api/apply`                      | `git apply` + one commit + writes `applied` + sha  |
| `POST /api/revert`                     | `git revert` a kaizen commit on a writable target  |

Every status write passes two gates: the transition must be legal in the spec,
and the destination phase's `requires` must already be present in the file
(patch on disk, sections non-empty). `applied` is server-owned — only the code
that saw the sha may write it. Apply additionally requires a writable target, a
clean tree, and `git apply --check`.

`events.mjs` watches only the feedback directories (not skills trees — apply
commits there would fire a storm; not scan roots — unbounded) and pushes
debounced SSE `change` events. Watchers start with the first subscriber and
stop with the last.

## The TUI

`kaizen tui` starts the server itself if the port is dead. Rust embeds
`lifecycle.json` at compile time (`include_str!`), so filters, abbreviations
and the `D` docs overlay work with the server down.

- `api.rs` — HTTP client, types, `queue()` (surfaced, non-terminal, score-sorted).
- `tui.rs` — app state, key dispatch, queue/detail drawing, the `f` filter:
  `open` (default — hides anything landed or terminal) → `undecided` →
  `approved` → all. Filter membership is derived from the spec, never from
  status names.
- `keys.rs` — every binding declared once; the help card and footer are built
  from the same table, so a key cannot be documented one way and bound another.
- `views/` — board (a lane per live status plus one closed lane, all spec-derived,
  empty lanes collapse), skills (failures per 100 lines of prose, worst first),
  settings (edit via `$EDITOR`, server validates).
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
- Nothing applies without an approval, and `git revert` must always be a clean
  undo — that is what the clean-tree guard protects.
- `kaizen doctor` is the self-review; its findings queue like any suggestion.

# kaizen

A perpetual improvement loop for Claude Code skills.

Skills that follow the `skill-reflect` convention file a suggestion after most runs — an ambiguous step, a missing edge case, an API that returned something unexpected. Without something that reads them, the folder quietly becomes an archive of problems nobody fixed.

Kaizen is the consumer. It reads your skills where they live, groups suggestions that describe the same failure, ranks them by what has actually kept happening, and proposes fixes you approve from a terminal UI.

The bias throughout: **a fix belongs at the lowest rung that works.**

| Rung | Mechanism                                               | Cost                                       | Use when                                       |
| ---- | ------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| 0    | Harness — a hook, a permission rule, a `CLAUDE.md` line | 0 tokens, cannot be skipped                | the rule must hold across every skill          |
| 1    | A script returning a verdict                            | one Bash call                              | inputs are fixed, the verdict is mechanical    |
| 2    | A written rule in `SKILL.md`                            | tokens every run, re-interpreted each time | the input genuinely varies and needs judgement |
| 3    | Left to reasoning                                       | tokens plus full drift                     | genuinely novel every time                     |

A proposal at rung 2 or 3 has to say why the rung below it does not work. That constraint is what makes the loop bend toward _faster_ over time instead of accumulating more instructions.

## Install

```bash
/plugin marketplace add /path/to/kaizen
/plugin install kaizen
/kaizen:init
```

`/kaizen:init` asks what to watch. Nothing is assumed about where skills live on your machine — there are no paths in this repository that name one.

## Use

| Command                | Does                                          |
| ---------------------- | --------------------------------------------- |
| `/kaizen:triage`       | triage the backlog, cluster it, propose fixes |
| `/kaizen:triage drain` | apply what you have already approved          |
| `/kaizen:init`         | change what is watched                        |

A `SessionStart` hook prints one line per session — untriaged count, and the cluster that has cost you the most. No model runs, so it costs nothing, and it means the backlog cannot be forgotten. It opens nothing: `SessionStart` fires for every terminal and scheduled run, and anything that launches itself all day stops being read.

## How it decides

**Grouping** is mechanical, so the same corpus always produces the same clusters. Suggestions join a group when they name the same target file, or when their vocabulary overlaps — weighted so that rare words like `origin` or `worktree` count and common ones like `check` or `step` do not. Grouping uses average linkage rather than single linkage, because single linkage chains: one borderline pair drags two unrelated groups together. Over-merging is worse than under-merging, since a wrong merge produces a confident wrong conclusion. You can always pin a grouping explicitly with `cluster:` in frontmatter, and a pin beats anything computed.

**Ranking** is arithmetic, not judgement:

```
score = impact x (1 + recurrences) / effort
```

Recurrence is the honest signal. A suggestion filed six times is six incidents, not one loud opinion. Untriaged items score zero so they sort below anything actually assessed.

**Promotion.** Once a cluster reaches 3 members or 5 incidents, patching one skill's prose stops being an acceptable fix — the cluster is evidence that prose already failed there repeatedly. Its fix must land at rung 0 or 1.

## Approval

Nothing applies without you, and there is no setting that changes that.

Approval happens per _cluster_, not per suggestion. Seven suggestions that share one fix are one decision. Requiring a click per row is how a backlog stops being drained, which is the exact failure this tool exists to correct.

Your approval is the authorisation — what happens after it can be automatic. A proposal that is already a validated patch is applied by the server with no model involved. One that still needs authoring waits for the next `/kaizen` run.

Applying is guarded:

- the target must be marked `writable` (project targets are read-only by default)
- the working tree must be clean, so `git revert` stays a clean undo
- `git apply --check` must pass before anything is offered

Every apply is one commit carrying a `Kaizen-Suggestion:` trailer, so `git log --grep=Kaizen-Suggestion` is the ledger and `git revert` is the rollback.

## The terminal UI

Ratatui over the same `node:http` API, bound to `127.0.0.1`. `kaizen tui` starts
the server itself if the port is dead, so there is one command. Four tabs, on
`1`–`4`:

| Tab          | What it is                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Queue**    | Every suggestion, ranked, with its detail beside it. `f` cycles the filter, `/` searches, `a`/`r` decide — and only where the model allows, so a key never just 409s. |
| **Clusters** | Suggestions that share one fix. `A` approves the whole cluster as one decision, which is the fastest thing in the tool.                                               |
| **Skills**   | What exists on disk, how much prose each carries, and how often it has failed per 100 lines. Worst ratio first.                                                       |
| **Settings** | The config, read-only, and whether each apply guard is _actually_ on right now. `e` hands the file to `$EDITOR`; the server validates what comes back.                |

`h` is help, `D` is the lifecycle, `d` is the patch under the cursor. There used
to be a React dashboard as well; two front ends over one API meant every change
to the model landed twice, and the second one kept being forgotten.

Skills are **read in place and never copied**, so a file edited in your editor is
current here with no sync step and no second copy to drift. The server watches
each feedback directory and pushes over SSE, so a suggestion filed while the TUI
is open appears on its own — `fs.watch` is not polling, so an idle watcher costs
nothing.

That loopback binding is the security boundary — these routes write files and
shell out to git. Every caller-supplied path is resolved (through symlinks) and
asserted inside a configured target before being touched.

## Your data

Nothing leaves your machine and nothing user-specific lives in this repository. Config sits in `~/.claude/kaizen/config.json`; suggestions stay in your own feedback directory.

## Layout

npm workspaces for the engine, one Rust crate for the front end.

| Package          | Holds                                                            | Depends on |
| ---------------- | ---------------------------------------------------------------- | ---------- |
| `@kaizen/core`   | the engine: parse, cluster, score, discover. Plain Node, no deps | nothing    |
| `@kaizen/server` | the local API on loopback                                        | core       |
| `tui/`           | the terminal UI, over that API                                   | the API    |

The boundary that matters: the engine decides, the TUI draws. Every derived fact
a view needs — a skill's health, a cluster's promotion, whether a status may
become another — is computed in `core` or read from `lifecycle.json`, so the
front end has nothing to re-derive and nothing to disagree with.

`lifecycle.json` at the root is the whole model: six phases, nine statuses, the
legal transitions between them, and what each phase must produce. Rust embeds it
at compile time; `docs/LIFECYCLE.md` is generated from it. `kaizen docs --check`
fails when the generated copy drifts, which is what makes it one source rather
than two that agree today.

## Development

```bash
npm install
npm run check    # docs freshness, format, lint, tests
npm run tui      # cargo build --release
cd tui && cargo test && cargo clippy --all-targets
```

Kaizen reviews itself against the same rubric it applies to skills: `kaizen doctor`
is that review as a script rather than a checklist, and what it finds is filed
into the `kaizen` feedback folder like any other suggestion, so it queues, scores
and ages alongside everything else rather than living in a page of its own.

## Licence

MIT

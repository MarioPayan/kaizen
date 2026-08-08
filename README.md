# kaizen

A perpetual improvement loop for Claude Code skills.

Skills that follow the `skill-reflect` convention file a suggestion after most runs — an ambiguous step, a missing edge case, an API that returned something unexpected. Without something that reads them, the folder quietly becomes an archive of problems nobody fixed.

Kaizen is the consumer. It reads your skills where they live, groups suggestions that describe the same failure, ranks them by what has actually kept happening, and proposes fixes you approve from a local app.

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
| `/kaizen:app`          | open the dashboard                            |
| `/kaizen:init`         | change what is watched                        |

A `SessionStart` hook prints one line per session — untriaged count, and the cluster that has cost you the most. No model runs, so it costs nothing, and it means the backlog cannot be forgotten. It never opens a browser: `SessionStart` fires for every terminal and scheduled run, and a dashboard that opens itself all day stops being read.

## How it decides

**Grouping** is mechanical, so the same corpus always produces the same clusters. Suggestions join a group when they name the same target file, or when their vocabulary overlaps — weighted so that rare words like `origin` or `worktree` count and common ones like `check` or `step` do not. Grouping uses average linkage rather than single linkage, because single linkage chains: one borderline pair drags two unrelated groups together. Over-merging is worse than under-merging, since a wrong merge produces a confident wrong conclusion. You can always pin a grouping explicitly with `cluster:` in frontmatter, and a pin beats anything computed.

**Ranking** is arithmetic, not judgement:

```
score = impact x (1 + recurrences) / effort
```

Recurrence is the honest signal. A suggestion filed six times is six incidents, not one loud opinion. Untriaged items score zero so they sort below anything actually assessed.

**Promotion.** Once a cluster reaches 3 members or 5 incidents, patching one skill's prose stops being an acceptable fix — the cluster is evidence that prose already failed there repeatedly. Its fix must land at rung 0 or 1.

## Approval

Nothing applies without you. `autoApply` exists in the config and ships empty.

Approval happens per _cluster_, not per suggestion. Seven suggestions that share one fix are one decision. Requiring a click per row is how a backlog stops being drained, which is the exact failure this tool exists to correct.

Your approval is the authorisation — what happens after it can be automatic. A proposal that is already a validated patch is applied by the server with no model involved. One that still needs authoring waits for the next `/kaizen` run.

Applying is guarded:

- the target must be marked `writable` (project targets are read-only by default)
- the working tree must be clean, so `git revert` stays a clean undo
- `git apply --check` must pass before anything is offered

Every apply is one commit carrying a `Kaizen-Suggestion:` trailer, so `git log --grep=Kaizen-Suggestion` is the ledger and `git revert` is the rollback.

## The app

React 19 + Vite + Tailwind, served by a `node:http` API bound to `127.0.0.1`. Six views: Queue, Clusters, Skills, Determinism, Settings, and one where the app reviews itself.

Skills are **read in place and never copied**, so a file edited in your editor is current here with no sync step and no second copy to drift.

That loopback binding is the security boundary — these routes write files and shell out to git. Every caller-supplied path is resolved (through symlinks) and asserted inside a configured target before being touched.

## Your data

Nothing leaves your machine and nothing user-specific lives in this repository. Config sits in `~/.claude/kaizen/config.json`; suggestions stay in your own feedback directory.

## Layout

npm workspaces, so a change in one package cannot quietly reach into another.

| Package          | Holds                                                                                              | Depends on |
| ---------------- | -------------------------------------------------------------------------------------------------- | ---------- |
| `@kaizen/core`   | the engine: parse, cluster, score, discover. Plain Node, no deps                                   | nothing    |
| `@kaizen/server` | the local API on loopback                                                                          | core       |
| `@kaizen/data`   | domain types, the API client, query hooks, the rules that hold regardless of how anything is drawn | nothing UI |
| `@kaizen/ui`     | the design system, built on [Base UI](https://base-ui.com). Presentational only                    | Base UI    |
| `@kaizen/app`    | routing, layout, and the views that compose the two above                                          | ui + data  |

The boundary that matters: `@kaizen/ui` does not know what a cluster is, and `@kaizen/data` does not know what colour a bug should be. Joining them is the app's job, and it is the only place that mapping lives. Redesigning is then a change to `ui` and the views — the engine, the API and the domain rules are untouched.

## Development

```bash
npm install
npm run check    # format, types, lint, tests — every package
npm run dev      # the app against a running API
npm run build
```

The app reviews itself against the same rubric it applies to skills — type checking, linting, tests and bundle size are rung-1 signals, and the "This app" view records what has been deliberately deferred and why.

## Licence

MIT

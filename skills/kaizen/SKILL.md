---
name: kaizen
description: Triage the improvement suggestions your skills have filed, group recurring failures, and propose fixes that push instructions down into scripts. Use when the user says "/kaizen", "triage my skills", "what should I fix in my skills", "review the skill backlog", "kaizen pass", or when a session-start line reports untriaged suggestions. Also use to drain approved proposals into applied commits.
---

# kaizen

Consume what `skill-reflect` produces. Skills file a suggestion after most runs; without something that reads them, the folder becomes an archive of problems nobody fixed. This skill is the consumer.

The bias throughout: **a fix belongs at the lowest rung that works.** A skill that keeps re-deriving the same shell command every run is slower, costlier and less reliable than one that calls a script. Moving work down the ladder is the point, not a side effect.

---

## The determinism ladder

| Rung | Mechanism | Cost | Use when |
|---|---|---|---|
| 0 | Harness — a hook, a permission rule, a `CLAUDE.md` line | 0 tokens, cannot be skipped | the rule must hold across every skill |
| 1 | A script in `_lib/` returning a verdict | one Bash call | inputs are fixed, the verdict is mechanical |
| 2 | A written rule in `SKILL.md` | tokens every run, re-interpreted each time | the input genuinely varies and needs judgement |
| 3 | Left to reasoning | tokens plus full drift | genuinely novel every time |

**Hard gate.** Every proposal records a `rung`, and a proposal at rung 2 or 3 must state in one sentence why the rung below it does not work. "It needs judgement" is only acceptable when the judgement is over something a script cannot observe. If a script could supply the *facts* and the model only weighs them, that is rung 1 plus rung 2 — split it, do not write it all as prose.

---

## Inputs

- `MODE` — (optional) `triage` (default), `drain`, `report`
- `TARGET` — (optional) a cluster id, suggestion id, or skill name to limit the pass

## Outputs

- Suggestion files updated in place with taxonomy and status
- Proposal patches written next to the suggestions they implement
- `SUMMARY` — what changed, what is waiting on the user

---

## Step 1 — Read the state

Run the scanner rather than walking directories by hand. It parses, scores, clusters and reports orphans deterministically, and it is the same code the app renders:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" scan --pretty
```

If it reports no config, stop and tell the user to run `/kaizen-init`. Do not guess at paths.

Note `metrics.untriaged`, the promoted clusters, and `warnings`. Warnings about a missing path are configuration problems — surface them, do not work around them.

## Step 2 — Triage the untriaged

Triage assigns labels. It changes no code, so it needs no approval — run it unattended.

For each suggestion where `triaged` is false, read the file and set:

| Field | Values |
|---|---|
| `type` | `determinism` · `structural` · `behavioral` · `content` · `tooling` · `hygiene` |
| `objective` | `bug` · `guardrail` · `feature` · `performance` · `clarity` · `debt` |
| `scope` | the file the fix lands in — a skill, a `_lib` module, `CLAUDE.md`, `settings.json` |
| `rung` | 0–3, per the ladder above |
| `effort` | `S` · `M` · `L` |
| `status` | `new` if no proposal yet |

Two rules while triaging:

- **`scope` matters more than it looks.** It is the strongest clustering signal available, and it is what makes the next run group correctly. Fill it in even when the fix is obvious.
- **Do not invent severity.** If the original author left it blank, read the Context and decide from what actually happened, or leave it blank and say so. A wrong label outranks a missing one in the queue, which is worse.

Then re-run the scan so clusters reflect the new `scope` values.

## Step 3 — Check what is already fixed

Before proposing anything, verify the problem still exists. These files span months; some describe behaviour that has since changed.

For each candidate, read the current `scope` file at HEAD. If the suggestion is already implemented, set `status: superseded` and note why in the body. This is cheap and it is the difference between a queue that shrinks and one that only grows.

## Step 4 — Cluster promotion

A cluster at or above the configured threshold (default: 3 members, or 5 incidents) is **promoted**. For a promoted cluster:

- The fix **must** land at rung 0 or rung 1. Patching one skill's prose is not an acceptable outcome — the cluster is proof that prose already failed there repeatedly.
- Add one line to the shared authoring conventions of the target tree so future skills inherit the rule.
- Write **one** proposal for the cluster, not one per member. Members reference it.

Say plainly which clusters were promoted and what single artefact each collapses into.

## Step 5 — Write proposals

A proposal is a real patch, not a description of one.

```bash
# in the target's skills directory
git diff > /tmp/kaizen-<cluster-or-id>.patch
git apply --check /tmp/kaizen-<cluster-or-id>.patch   # must pass before it is offered
```

Store the patch beside the suggestion as `<suggestion-basename>.patch`, set `status: proposed`, and record the rung justification in the body under `## Proposal`.

For a rung-1 proposal, the script it introduces ships with a `--self-check` flag that exercises it against a known case. A script with no way to prove it works is not an improvement over the prose it replaced.

If a proposal cannot be written without judgement calls the user should make, leave `status: new` and explain what is undecided. Do not write a speculative patch.

## Step 6 — Present, and stop

Show a ranked table: cluster or suggestion, incidents, rung, scope, one-line proposal. Highest score first.

**Nothing applies without the user's approval** unless `autoApply` in the config matches, which by default it does not. Say what is waiting and stop. The app is the other way to approve — point at it if the queue is long, because approving a cluster there is one action instead of many.

## Step 7 — Drain (`MODE=drain`)

For each suggestion at `status: approved`:

1. Confirm the target is `writable` in config. Project targets are read-only by default; refuse and say so.
2. Confirm the tree is clean: `git -C <skills> status --porcelain` must be empty. Applying into a dirty tree mixes the user's work with kaizen's and makes `git revert` stop being a clean undo. Refuse and say which files are dirty.
3. `git apply` the patch, run the script's `--self-check` if there is one.
4. Commit one suggestion per commit:

```
kaizen(<type>/<objective>): <cluster or slug>

<one line on what changed and why>

Kaizen-Suggestion: <suggestion id>
```

5. Set `status: applied` and `applied_sha` to the new commit.

`git log --grep=Kaizen-Suggestion` is then the applied-changes ledger, for free. Rollback is `git revert <sha>`.

## Step 8 — Review this plugin's own app

The app is not exempt. Once per pass, check `app/` against the same rubric and file anything real into the `kaizen-app` feedback folder:

- `npm --prefix app run check` — type errors, lint, tests, all rung-1 signals
- any view that has gone unopened, any number not traceable to a file on disk
- anything sitting at `proposed` for two weeks, which means the approval flow has friction

## Step 9 — Reflect

Apply `${CLAUDE_PLUGIN_ROOT}/skills/_lib/skill-reflect.md` (inputs: `SKILL_NAME=kaizen`, `OUTCOME=<complete|partial|errored>`, `WHAT_RAN=<one or two sentences>`).

---

## Edge cases

- **Orphaned feedback.** A folder whose skill no longer exists still holds real findings, often the same live problem under a renamed skill. Remap to the successor where one plainly exists; otherwise move to `_archive/` inside the feedback directory. Never delete.
- **Stale paths in old proposals.** Suggestions written before a reorganisation reference paths that no longer exist. Remap to the current path during triage; if the module is gone entirely, mark `superseded`.
- **A cluster the user disagrees with.** Pin the correct grouping with `cluster: <name>` in frontmatter. A pin always beats the computed grouping, and differently-pinned suggestions never merge.
- **Nothing to do.** Say so in one line and stop. A pass that reports nothing is a good outcome, not a failed run.

## Notes

- Suggestion files are the only state. There is no index to rebuild and nothing to keep in sync.
- The scanner is deterministic; if a number looks wrong, the fix belongs in `scripts/lib/`, not in a workaround here.

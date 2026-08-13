---
name: kaizen
description: Triage the improvement suggestions your skills have filed, categorise recurring failures, and propose fixes that push instructions down into scripts. Use when the user says "/kaizen:triage", "/kaizen", "triage my skills", "what should I fix in my skills", "review the skill backlog", "kaizen pass", or when a session-start line reports untriaged suggestions. Also use to drain approved proposals into applied commits.
---

# kaizen

Consume what `skill-reflect` produces. Skills file a suggestion after most runs; without something that reads them, the folder becomes an archive of problems nobody fixed. This skill is the consumer.

The bias throughout: **a fix belongs at the lowest rung that works.** A skill that keeps re-deriving the same shell command every run is slower, costlier and less reliable than one that calls a script. Moving work down the ladder is the point, not a side effect.

---

## The lifecycle

Six phases, and a suggestion rests in exactly one status between each. The phases, the statuses, what each phase must produce, and which transitions are legal are **not written here** — they live in `lifecycle.json` at the repo root, which the app, the TUI and `docs/LIFECYCLE.md` all read. Restating them in this file would be a sixth copy, and the five that already existed are why the spec exists.

| Phase | Who | Step below | Comes to rest at |
|---|---|---|---|
| Capture | the skill that hit the problem | `skill-reflect`, not this skill | `recorded` |
| Triage | kaizen, unattended | Steps 2–4 | `triaged` |
| Plan | kaizen, unattended | Step 5 | `planned` |
| Decide | **you** | Step 6 | `approved` |
| Apply | the server | Step 7 | `applied` |
| Verify | kaizen, unattended | Step 7, after the commit | `verified` |

Read it with `kaizen docs`, in the app's Docs tab, or with `D` in the TUI. All three render the same file.

Two things the phases exist to prevent, both observed:

- **Approval with nothing behind it.** `approved` is reachable only from `planned`, and `planned` requires a patch *and* a validation plan. A pass that once left 39 suggestions approved with no patch could not have written that down under this model.
- **A fix nobody confirmed was needed.** Triage re-reads the scope file at HEAD before labelling. 27 of those 39 had already been fixed months earlier; the status said otherwise because nothing ever re-checked.

Files written before the spec carry the older names — `new` and `proposed`. They are read as `recorded` and `planned`; the aliases are in the spec and every renderer resolves them.

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
- `TARGET` — (optional) a category id, suggestion id, or skill name to limit the pass

## Outputs

- Suggestion files updated in place with taxonomy and status
- Proposal patches written next to the suggestions they implement
- `SUMMARY` — what changed, what is waiting on the user

---

## Step 1 — Read the state

Run the scanner rather than walking directories by hand. It parses, scores, categorises and reports orphans deterministically, and it is the same code the app renders:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" scan --pretty
```

If it reports no config, stop and tell the user to run `/kaizen:init`. Do not guess at paths.

Note `metrics.untriaged`, the promoted categories, and `warnings`. Warnings about a missing path are configuration problems — surface them, do not work around them.

## Step 2 — Triage

Triage does two things: **confirm the problem is still real** (Step 3, which is
a gate, not an afterthought) and **label it**. It changes no code, so it needs no
approval — run it unattended.

**Do not open the files and do not hand-edit frontmatter.** The scan from Step 1
already carries every suggestion's `id`, `context`, `suggestion` and `rationale` —
reading the files again buys nothing and costs a token per line. Decide from the
scan output, then write the whole pass in one call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" triage --apply decisions.json
# decisions.json: [{ "id": "<exact id from the scan>", "type": …, "objective": …,
#                    "scope": …, "rung": "1", "effort": "S",
#                    "confirmed_at": "2026-08-09 @ c9168b6", "status": "triaged" }, …]
```

It validates every value against the closed vocabularies and **writes nothing if
any entry is bad**, so a typo costs one retry rather than leaving half the queue
in a state nobody planned. Copy `id` verbatim from the scan — it is
`target/skill/filename.md` and reconstructing it from the slug gets the date wrong.
Add `--dry-run` to see the count first, `--self-check` to prove the writer works.

For each suggestion where `triaged` is false, decide:

| Field | Values |
|---|---|
| `type` | `determinism` · `structural` · `behavioral` · `content` · `tooling` · `hygiene` |
| `objective` | `bug` · `guardrail` · `feature` · `performance` · `clarity` · `debt` |
| `scope` | the file the fix lands in — a skill, a `_lib` module, `CLAUDE.md`, `settings.json` |
| `rung` | 0–3, per the ladder above |
| `effort` | `S` · `M` · `L` |
| `confirmed_at` | the date and short sha you re-read the scope file at, per Step 3 |
| `status` | `triaged` once confirmed and labelled · `superseded` if the fix already landed |

Two rules while triaging:

- **`scope` matters more than it looks.** It IS the category: suggestions sharing a scope share one fix and one decision. Measured on the first full pass: supplying it collapsed 34 vague groups into 9 that each name exactly one file. When the fix is a script that does not exist yet, name the path it *would* live at — that is what gathers "five wrong `gh` commands in one skill" into one decision.
- **Do not invent severity.** If the original author left it blank, read the Context and decide from what actually happened, or leave it blank and say so. A wrong label outranks a missing one in the queue, which is worse.

Then re-run the scan so categories reflect the new `scope` values.

## Step 3 — Confirm the problem still exists

**This is the gate on `triaged`, not an optional politeness.** These files span
months and the code moved on: on the first full pass, 27 of 39 approved
suggestions had already been fixed and nothing recorded it.

For each candidate, read the current `scope` file at HEAD.

- **Still a real problem** → record which commit you checked against:

  ```bash
  git -C <skills> rev-parse --short HEAD
  ```

  Put that in `confirmed_at` alongside the date, e.g. `2026-08-09 @ c9168b6`.
  The triage phase requires it, so a suggestion cannot reach `triaged` without
  one — the server refuses the transition and names the missing field.

- **Already implemented** → `status: superseded`, and say in the body *where*
  the fix lives. "Implemented in `_lib/pr/find-clone.sh`, which matches any
  remote" is checkable; "already done" is not, and the next pass has to redo the
  work to find out.

A confirmation is worth exactly as much as its commit. If the tree has moved a
long way since, confirm again rather than trusting an old stamp.

## Step 4 — Category promotion

A category at or above the configured threshold (default: 3 members, or 5 incidents) is **promoted**. For a promoted category:

- The fix **must** land at rung 0 or rung 1. Patching one skill's prose is not an acceptable outcome — the category is proof that prose already failed there repeatedly.
- Add one line to the shared authoring conventions of the target tree so future skills inherit the rule.
- Write **one** proposal for the category, not one per member. Members reference it.

Say plainly which categories were promoted and what single artefact each collapses into.

## Step 5 — Plan

The plan phase produces three things, and the server will not let a suggestion
reach `planned` without all three. That is deliberate: an approval with nothing
behind it is the failure this whole model exists to prevent.

**1. `## Plan`** — the change, concretely. Which files, which edits, and what
deliberately stays out. Include the rung justification here: a rung 2 or 3 fix
must say in one sentence why the rung below does not work.

**2. `## Validation`** — how we will know it worked. One command and the result
that counts as passing:

| Fix is | Validation is |
|---|---|
| a rung-1 script | `bash <script> --self-check` exits 0 |
| a code change | the test that fails before and passes after, by name |
| prose in a skill | the observable behaviour to look for on the next run |

"Read it and see if it looks right" is not a validation plan. If you cannot say
what would prove the fix worked, that is a sign the fix is not understood yet —
leave it at `triaged` and say so.

**3. The patch** — a real diff, not a description of one:

```bash
# in the target's skills directory
git diff > /tmp/kaizen-<category-or-id>.patch
git apply --check /tmp/kaizen-<category-or-id>.patch   # must pass before it is offered
```

Store it beside the suggestion as `<suggestion-basename>.patch`.

Then set `status: planned`. For a rung-1 proposal the script it introduces ships
with `--self-check` — which is usually also its validation plan, so the two fall
out of the same work.

If a plan cannot be written without judgement calls the user should make, leave
`status: triaged` and explain what is undecided. Do not write a speculative
patch to satisfy the gate.

## Step 6 — Present, and stop

This is the one attended phase, so it is the only place the loop pauses.

Show a ranked table for everything at `planned`: category or suggestion,
incidents, rung, scope, the one-line plan, **and how it will be validated**. The
validation column is the point — it is what turns "do you want this change" into
"do you want this change, and here is how we will know it worked". Highest score
first.

**Nothing applies without the user's approval.** There is no bypass — the config used to declare an `autoApply` list and nothing ever read it, so the setting has been removed rather than left describing behaviour that did not exist. Say what is waiting and stop.

The TUI is the other way to approve, and the faster one when the queue is long: `kaizen tui`, tab 2, `A` approves a whole category as one decision.

## Step 7 — Apply, then verify (`MODE=drain`)

For each suggestion at `status: approved`:

1. Confirm the target is `writable` in config. Project targets are read-only by default; refuse and say so.
2. Confirm the tree is clean: `git -C <skills> status --porcelain` must be empty. Applying into a dirty tree mixes the user's work with kaizen's and makes `git revert` stop being a clean undo. Refuse and say which files are dirty.
3. `git apply --index` the patch (staging exactly the paths it touches — a patch cannot then be half-committed by a wrong `git add`), run the script's `--self-check` if there is one.
4. Commit one suggestion per commit:

```
kaizen(<type>/<objective>): <category or slug>

<one line on what changed and why>

Kaizen-Suggestion: <suggestion id>
```

5. After the validation plan has run (next section), stamp the whole walk in one call — it checks every transition and every phase requirement against the spec, all-or-nothing:

```bash
kaizen drain --apply - <<'JSON'
[{ "id": "<suggestion id>", "sha": "<commit>", "verified_at": "<date — what the validation returned>" }]
JSON
```

`git log --grep=Kaizen-Suggestion` is then the applied-changes ledger, for free. Rollback is `git revert <sha>`.

### Then verify — the drain is not finished at `applied`

`applied` means git accepted a diff. It does not mean the problem is fixed, and
treating the two as the same thing is why a queue can fill with landed changes
nobody ever checked.

For each suggestion just applied, run the command its `## Validation` section
names, against the tree the commit landed in:

- **It passes** → `status: verified`, and stamp `verified_at` with the date and
  what the command returned. That is a terminal state, and the only one that
  claims the loop closed.
- **It fails** → `status: failed`, and put the output in the body. `failed` goes
  back to `planned`, not to the start: the problem is still real and still
  triaged, only the fix was wrong. Do not revert automatically — show the user
  the failure and the `git revert <sha>` that undoes it, and let them choose.

A validation plan that cannot be run — because it named something vague — is
itself a finding. File it against the plan step rather than marking the
suggestion verified on the strength of the diff looking correct.

## Step 8 — Run the rubric against kaizen itself

Kaizen is not exempt from the loop it runs. Once per pass:

```bash
npm run check --prefix "${CLAUDE_PLUGIN_ROOT}"          # rung-1 signals: types, lint, tests
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" doctor --file
```

`doctor` **is** this step. It used to be a prose checklist here — "has any view
gone unopened", "is anything sitting at proposed for two weeks" — and every
defect it was meant to catch was in fact caught by hand, once, by whoever
happened to look. That is rung 3, in the tool whose whole argument is that rung 3
is where failures come from. The checklist is now a check:

| Check | Catches |
|---|---|
| `dead-config-key` | a setting the UI offers that no code reads — a promise the tool does not keep |
| `decided-without-a-patch` | `approved` meaning "nobody has written it"; `/api/apply` 422s on every one |
| `stale-decision` | anything past the drain window, which means the approval flow has friction |
| `capture-quality` | the share of suggestions arriving with no `scope`, measured rather than asserted |
| `script-without-self-check` | a rung-1 fix with no way to prove it works — which is not an improvement on the prose it replaced |

`--file` writes each finding into the `kaizen` feedback folder in the same format
as any other suggestion, so it queues, categorises and scores alongside them. There
is deliberately no special case for the tool complaining about itself: if a
finding cannot earn its place against the real backlog, it should not be acted on.

**Adding a check is the main way this skill improves.** When a pass finds
something by hand — as every check above was found — the fix is not to write it
down here. Ask whether a script could have found it, and if so add it to
`packages/core/src/doctor.mjs` with a test that fails without it. A check is
rung 1; a paragraph in this file is rung 2 and will be re-interpreted every run.
The rubric is only as good as the last thing someone bothered to automate.

What `doctor` still cannot see, and so is genuinely yours to judge each pass:
whether a view has gone unopened, whether a number on screen is traceable to a
file on disk, and whether the taxonomy is still carving the backlog at its
joints. If you find a way to check one of those, it stops being on this list.

Triage itself reads the full state and is **not** filtered by `surface`. If it were, a muted type could never be labelled, and so could never become un-muted.

## Step 9 — Reflect

Apply `${CLAUDE_PLUGIN_ROOT}/skills/_lib/skill-reflect.md` (inputs: `SKILL_NAME=kaizen`, `OUTCOME=<complete|partial|errored>`, `WHAT_RAN=<one or two sentences>`).

---

## Recurring asks

A separate, unattended entry point. The session hook runs it on the `cadence.weekly` slot; nobody is watching, so it files suggestions and stops. Everything above this section is the attended triage pass and does not apply here.

`kaizen asks --json` arrives on **stdin**:

- `asks: [{ project, text, n, last }]` — the corpus, where `n` counts verbatim repeats. Slash commands and `!` shell lines are already filtered out; an ask you invoke by name has a skill, which is the outcome being looked for.
- `known: [{ slug, scope, seen }]` — what previous passes already filed. This is the dedup list, and it is given to you rather than left somewhere to go and find.
- `window` — how many days the corpus covers. Narrower than the configured window on every pass after the first, because everything older has already been judged.
- `max` — the ceiling on new files this pass.

You are here for one judgement the extractor cannot make: **which asks are the same ask.** `n` only counts verbatim repeats; the real signal is ten differently-worded prompts that describe one recurring job. Do not group by wording — group by what the work actually was. Lexical grouping was tried on this corpus and returned URLs and file paths.

File a suggestion when all of these hold:

- The same job appears **three or more times**, across separate days.
- No existing skill covers it. Check the configured skills directories before filing — a skill that exists but did not get invoked is a discoverability problem, and that is still worth filing, but say so.
- The job has a fixed enough shape to write down. "Fix the failing test" is not an ask; "open a PR from this branch and watch CI" is.

Write each one with `${CLAUDE_PLUGIN_ROOT}/skills/_lib/skill-reflect.md`, with these differences:

- `skill: session` — no skill ran, so it files under the reserved name.
- `scope:` — the path the skill or script **should** live at. That is what puts three separate reports of the same missing skill into one category.
- `## Evidence` — the prompts themselves, verbatim from the corpus, with their counts and dates. This is the only receipt there will ever be; a summary is not one.

Then the rules that keep an unattended pass from becoming its own problem:

- **Dedup against `known` first.** A recurring ask recurs every week by definition. Check every candidate against `known` before writing; on a match, append `## Recurrence — <date>` to that file instead of filing a new one. Refiling is the failure mode that would bury the queue this is meant to fill, and a rising `seen` is the signal — not a second file saying the same thing.
- **At most `max` files per pass.** Highest count first. The cap is in the input for a reason.
- **Nothing else.** No commits, no edits to any skill, no report. The files are the entire output — they surface in the next session's status line on their own.
- **Nothing to file is the normal outcome.** Most weeks add no new recurring ask.

---

## Edge cases

- **Orphaned feedback.** A folder whose skill no longer exists still holds real findings, often the same live problem under a renamed skill. Read them before deciding: a finding about a shared `_lib/` module usually survives its skill's rename and should be remapped, while one about machinery that has been removed outright should not. Remap with `mv` into the successor's folder **plus** `"skill": "<successor>"` in the triage call — the folder is the scanner's signal but frontmatter wins, so moving alone leaves the orphan warning up. Otherwise move the folder under `_archive/` in the feedback directory, which the scanner skips. Never delete.
- **A skill the scanner cannot see.** A feedback folder for a skill that lives outside every configured `skills` path — a plugin's own skills, for instance — is reported as an orphan and is not one. Check whether the skill exists somewhere unscanned before remapping or archiving it.
- **Stale paths in old proposals.** Suggestions written before a reorganisation reference paths that no longer exist. Remap to the current path during triage; if the module is gone entirely, mark `superseded`.
- **A category the user disagrees with.** Pin the correct grouping with `category: <name>` in frontmatter (`cluster:` is still read as the old spelling). A pin always beats the scope/skill key, and differently-pinned suggestions never merge.
- **Nothing to do.** Say so in one line and stop. A pass that reports nothing is a good outcome, not a failed run.

## Notes

- Suggestion files are the only state. There is no index to rebuild and nothing to keep in sync.
- The scanner is deterministic; if a number looks wrong, the fix belongs in `scripts/lib/`, not in a workaround here.

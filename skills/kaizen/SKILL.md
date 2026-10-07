---
name: kaizen
description: Triage the improvement suggestions your skills have filed, group recurring failures by skill, and propose fixes that push instructions down into scripts. Use when the user says "/kaizen:triage", "/kaizen", "triage my skills", "what should I fix in my skills", "review the skill backlog", "kaizen pass", or when a session-start line reports untriaged suggestions. Also use to drain approved proposals into applied commits.
---

# kaizen

Consume what `skill-reflect` produces. Skills file a suggestion after most runs; without something that reads them, the folder becomes an archive of problems nobody fixed. This skill is the consumer.

The bias throughout: **a fix belongs at the lowest rung that works.** A skill that keeps re-deriving the same shell command every run is slower, costlier and less reliable than one that calls a script. Moving work down the ladder is the point, not a side effect.

---

## The lifecycle

Seven phases, and a suggestion rests in exactly one status between each. The phases, the statuses, what each phase must produce, and which transitions are legal are **not written here** — they live in `lifecycle.json` at the repo root, which the app, the TUI and `docs/LIFECYCLE.md` all read. Restating them in this file would be a sixth copy, and the five that already existed are why the spec exists.

| Phase | Who | Step below | Comes to rest at |
|---|---|---|---|
| Capture | the skill that hit the problem | `skill-reflect`, not this skill | `recorded` |
| Triage | codex, checked by codex | Steps 2–4 | `triaged` |
| Plan | codex, checked by codex | Step 5 | `planned` |
| Decide | **you** | Step 6 | `approved` |
| Apply | the server | Step 7 | `applied` |
| Review | codex, checked by claude | Step 7a | `reviewed` |
| Verify | claude | Step 6b, on a `reviewed` card | `verified` |

Read it with `kaizen docs`, in the app's Docs tab, or with `D` in the TUI. All three render the same file.

Two things the phases exist to prevent, both observed:

- **Approval with nothing behind it.** `approved` is reachable only from `planned`, and `planned` requires a patch *and* a validation plan. A pass that once left 39 suggestions approved with no patch could not have written that down under this model.
- **A fix nobody confirmed was needed.** Triage re-reads the scope file at HEAD before labelling. 27 of those 39 had already been fixed months earlier; the status said otherwise because nothing ever re-checked.

Files written before the spec carry the older names — `new` and `proposed`. They are read as `recorded` and `planned`; the aliases are in the spec and every renderer resolves them.

---

## Who runs what

The spec says who each phase belongs to (`runner` and `reviewer` on each phase),
and the Claude subscription buys exactly one run per suggestion:

- **codex is the runner.** It does the work of every unattended phase — triage, plan, and the review of a landed change — on the ChatGPT subscription. If you are codex reading this from a server run without a mode, your `MODE` is `run`.
- **codex is also its own checker, up to the decision.** A `triaged` or `planned` card is flagged for codex, and a second codex run re-asks the phase's own gate against what the first one wrote. Same subscription, fresh context, a checking brief rather than a doing one. If you are codex reading this in `MODE=review`, take only the cards whose `needs_review` names codex.
- **claude is the verify, and nothing else.** It does not triage, plan, or review; it takes a `reviewed` card, runs the validation plan against the change that actually landed, and says whether the loop closed. That is the one Anthropic call a suggestion costs. If you are claude reading this from a server run, your `MODE` is `review` and the only cards that are yours are the `reviewed` ones.
- **The flag is the hand-off.** Every status the runner writes is provisional. Go as far as the phase gates let you in one run — a `recorded` card is triaged *and then planned* before it is handed over, so one check covers the labels and the plan — and write `"needs_review": "codex"` in the same `triage --apply` call as the status you stop at. A card you leave short of `planned` (a call only the user can make, per Step 5) is flagged where it stops. The board draws a flagged card in the `review` lane, the server hands the next seat to the name on the flag, and nothing — not `A`, not a sweep — can move the card forward until that name clears it. A status without the flag is a status a check has agreed with.
- **A check that fails sends the card back.** The checker writes the status one phase back (`planned → triaged`, `triaged → recorded`, `reviewed → applied`), clears the flag, parks the card on the user with `"blocked_on": "review: <one line>"`, and puts the findings under `## Verdict`. A landing that cannot happen parks the card the same way — `"blocked_on": "apply: <git's line>"` — and a runner that needs a call only the user can make parks it in its own words (Step 5).
- **A parked card offers its ways out.** `a` on it opens the menu: send it back for a new plan, clear the block, answer it, move it to the target whose repo the fix lands in, supersede, reject. What the user types lands under `## Answer`. A card that comes round again therefore carries a `## Verdict` and/or an `## Answer`, and **the runner reads both as its brief** before doing anything else. `x` is still the way out.
- **The server chains them.** One `a` on a card, one `A` on a lane, one `kaizen dispatch [id]`: a run does, flags, exits; the next run checks, clears or sends back. Neither is sent by hand.

**In an interactive Claude session**, `/kaizen:triage [id]` is a hand-off, not a pass. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" dispatch [id]` — the server must be up (`kaizen serve`; `kaizen tui` starts it) — report what it said, and stop. Do not triage or plan yourself. `review`, `drain` and `report` still run where they are invoked.

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

- `MODE` — (optional) `run` (the runner's pass: Steps 1–5 and 7a), `review` (the checker's: Step 6b — only the cards the flag names you on), `drain` (Step 7), `report` (read-only). No mode in an interactive Claude session means the hand-off above.
- `TARGET` — (optional) a suggestion id or skill name to limit the pass

## Outputs

- Suggestion files updated in place with taxonomy and status
- Proposal patches written next to the suggestions they implement
- `SUMMARY` — what changed, what is waiting on the user

---

## Step 1 — Read the state

Run the scanner rather than walking directories by hand. It parses, scores and reports orphans deterministically, and it is the same code the app renders:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" scan --pretty
```

If it reports no config, stop and tell the user to run `/kaizen:init`. Do not guess at paths.

With `TARGET` set, read only what the pass will decide on: `scan --pretty --id
<TARGET>` for a suggestion id, `--skill <TARGET>` for a skill name (`--scope
<path>` answers Step 4 in one command; `scan --help` lists them). A pass fenced
to one card should not pay for the whole corpus to find it.

Note `metrics.untriaged` and `warnings`. Warnings about a missing path are configuration problems — surface them, do not work around them.

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

Then go on to plan (Step 5) in the same run. The `needs_review` flag goes on the
status you stop at — `planned`, normally — not on `triaged` in passing: one
check covers both, and a flag here would cost a check run and a second
runner run for nothing.

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
| `needs_review` | `codex`, beside the status you stop at — the hand-off; the checker clears it |

Two rules while triaging:

- **`scope` matters more than it looks.** Suggestions sharing a scope share one fix and one decision. Measured on the first full pass: supplying it collapsed 34 vague groups into 9 that each name exactly one file. When the fix is a script that does not exist yet, name the path it *would* live at — that is what gathers "five wrong `gh` commands in one skill" into one decision.
- **Do not invent severity.** If the original author left it blank, read the Context and decide from what actually happened, or leave it blank and say so. A wrong label outranks a missing one in the queue, which is worse.

Then re-run the scan so the state reflects the new `scope` values.

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

## Step 4 — Repeated scopes

When several suggestions share one `scope`, first confirm they describe the same
recurring mechanism or remediation. A shared file alone — especially a large
`SKILL.md` — is not evidence of one fix: cards about independent behaviour keep
separate proposals and their individually lowest workable rungs. For a scope
with 3+ such members or 5+ such incidents:

- The fix **must** land at rung 0 or rung 1. Patching one skill's prose is not an acceptable outcome — the recurrence is proof that prose already failed there repeatedly.
- Add one line to the shared authoring conventions of the target tree so future skills inherit the rule.
- Write **one** proposal for the scope, not one per member. Members reference it as data: `"blocked_on": "carried by <lead slug>"` on each. The lead owns the `.patch`; each member still gets its own `## Plan` and `## Validation`, reaches `planned` on that carrier patch, receives its check, then stays parked until the lead lands. Only the lead is approved and applied. That explicit relation is what patch lookup and landing read — a card that merely shares the file, with its own problem, neither borrows the patch nor closes.

Say plainly which scopes cross that line and what single artefact each collapses into.

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
| prose in a skill | a command that checks the required instruction is present and runs the repository's normal checks; name the next real run to observe separately |

Write the command as one fenced `bash` block. `kaizen verify --dry` extracts
that block verbatim and runs it from a throwaway worktree with the sidecar patch
applied. Use worktree-relative paths or `$KAIZEN_TARGET_ROOT`; an absolute path
to the live tree validates the unpatched file instead.
Because the block is executable shell source, quote it for the shell that runs
it. In particular, single-quote a `node -e` program whose assertions contain
Markdown backticks; double quotes would execute those backticks as command
substitutions before Node starts.

"Read it and see if it looks right" is not a validation plan. If you cannot say
what would prove the fix worked, that is a sign the fix is not understood yet —
leave it at `triaged` and say so.

A future model run is evidence to watch for, not lifecycle validation: a prose
plan must include an immediate deterministic proxy, and may name the next real
run as a non-gating follow-up. `reviewed` and `verified` then claim only that the
instruction landed and the proxy passed, never that unobserved future behaviour
was validated. File a recurrence through `skill-reflect` if that later run shows
the instruction did not hold; do not invent a synthetic task during review.

Both sections are written through the same call as the frontmatter, so a plan
pass is one write like triage and verify: `kaizen triage --apply` with
`[{ "id": …, "status": "planned", "plan": "…", "validation": "…" }]` upserts
`## Plan` and `## Validation` (replacing a present section, appending an absent
one) and flips the status in the same all-or-nothing batch. Do not `cat >>` the
body by hand.

**Parking an item is data, not prose.** Whenever you leave something short of
the next phase because of a decision only the user can make — where content
should live, a repo that is not writable, a structural call — record the reason
in one line via the triage CLI: `"blocked_on": "<why>"`. The queue and the
board flag it and show the line, which is how the user learns nine rows are
waiting on three calls without reading a report. The user answers from the
board's menu, and what they said lands under `## Answer` — read it when the
card comes round again; it is the call you asked for. A final report in prose
is still welcome; it is just not the only place the reason lives.

**3. The patch** — a real diff, not a description of one. Make it in a
throwaway worktree at HEAD, never in the live tree. Allocate it with
`wt="$("${CLAUDE_PLUGIN_ROOT}/skills/_lib/proposal-worktree.sh" <repo>)"`; the
helper uses a fresh path so residue from an interrupted pass cannot collide with
the next one. For the kaizen repo also run `npm ci --prefix "$wt"
--ignore-scripts` so it has its own `node_modules` and
`@kaizen/*` resolves inside the worktree instead of back to the live tree.
Retain that exact `wt` value as this run's allocation receipt and remove only
that path during cleanup. Never treat `git worktree list` as a cleanup queue,
and never remove an unfamiliar worktree: a clean tree, a familiar prefix or an
old timestamp does not prove ownership. If the allocation receipt is lost, leave
the worktree in place rather than guessing.
Someone else's uncommitted work would otherwise ride into the diff, and the
tests would exercise their WIP instead of the patch — 21 modified files of
foreign WIP sat in the kaizen repo during the 2026-08-15 pass. The capture
command below accepts the target repo, the exact path returned by
`proposal-worktree.sh`, the output patch, and optional intentional new paths. It
cleans and checks the throwaway tree, removes only that allocation and its empty
parent, then checks the patch against the live tree. Run it from a stable
directory, not from inside the worktree it removes. **Never `git stash` in the
worktree**: the stash is shared with the live repo, and eight passes left eight
`WIP on (no branch)` entries in the user's skills repo that way.

Runner mode may write suggestion files and sidecar patches under configured
feedback directories, but it must not edit any target-tree file directly. A
lesson learned while running is a `recorded` suggestion, not an immediate edit
to the skill or module it concerns; that target changes only when its reviewed,
approved sidecar patch lands.

```bash
"${CLAUDE_PLUGIN_ROOT}/skills/_lib/proposal-patch.sh" \
  --worktree <repo> "$wt" \
  /tmp/kaizen-<scope-or-id>.patch [<new paths>...]
```

Pass only intentional new files as `<new paths>`; the helper uses intent-to-add
so they enter the diff, then resets those paths before cleaning the worktree.
Omit the optional arguments when the proposal creates no files.

Store it beside the suggestion as `<suggestion-basename>.patch`. For a repeated-scope proposal, store it beside the lead only; members borrow it through the `blocked_on` relation from Step 4, never merely because they share a scope.

If this replaces the sidecar of an `approved` card, the approval no longer
names the patch on disk. In the same `triage --apply` call, return the card to
`planned` with `needs_review: codex` (and update Plan or Validation when the
change altered them). `approved_patch` is server-owned: the next attended
approval stamps the new sidecar identity, and apply refuses a sidecar that no
longer matches it.

Once the sidecar patch exists, write the complete plan, validation, labels,
`status: planned`, and `"needs_review": "codex"` in one `triage --apply` call.
Only then run `kaizen verify --dry <id>`: the command accepts `planned` cards,
applies the sidecar patch, and runs the fenced `bash` block above in a throwaway
worktree. A validation that has not passed is not ready for review.

If verification fails, repair the patch or validation and rerun it. If it cannot
be repaired in the current pass, use `triage --apply` to return the card to
`triaged`, clear `needs_review`, and set `blocked_on` to
`plan: dry verification failed — <one line>` with the command output in
`## Verdict`; never leave a failing plan flagged as ready for review.

For a rung-1 proposal the script it introduces ships with `--self-check` — which
is usually also its validation plan, so the two fall out of the same work.

If a plan cannot be written without judgement calls the user should make, leave
`status: triaged` and explain what is undecided. Do not write a speculative
patch to satisfy the gate.

## Step 6 — Stop

This is where the runner stops. Do not present a table for approval: a plan is
not approvable until a check has cleared it, and the flag you wrote is what
sends the checker. Say in one line what you flagged and what you parked, and end.

**Nothing applies without the user's approval.** There is no bypass — the config used to declare an `autoApply` list and nothing ever read it, so the setting has been removed rather than left describing behaviour that did not exist. The decision is the one attended phase, and it happens on the board: `kaizen tui`, where a checked plan sits in `planned` with its patch (`d`) and its validation plan (`enter`), `a` approves one and `A` the lane.

## Step 6b — Check (`MODE=review`)

The checker's pass. Read the state (Step 1) and take every card whose
`needs_review` **names you** — or the one `TARGET` names. codex owns the
`recorded`, `triaged` and `planned` rows; `reviewed` is claude's, and it is the
only row claude has. Taking a row that is not yours spends the wrong
subscription. For each, the check is the phase's own gate re-run with a checking
brief rather than a doing one:

| Card is | Check |
|---|---|
| `recorded` | Confirm that stopping before triage was justified and that the reason still holds. On a pass, clear the flag and write the verdict without advancing the status; the runner resumes with `## Verdict` and/or `## Answer` as its brief. There is no earlier status to send it back to. |
| `triaged` | The labels fit the Context — type, objective, effort, and a rung with its one-sentence justification; `scope` names the file the fix lands in; `confirmed_at` names a commit, and the problem is still there at HEAD — or the card should have been `superseded`, with where the fix lives. |
| `planned` | Everything in the `triaged` row first — the labels arrived in the same run, unchecked. Then: `## Plan` says which files and what stays out; `## Validation` names a command and a passing result, not "read it and see"; the sibling `.patch` passes `git apply --check` against the live tree and against an isolated worktree allocated by `proposal-worktree.sh`, and does what the plan says, nothing more; the rung is the lowest that works. |
| `reviewed` | This is the verify phase. Run the command `## Validation` names against the tree the commit landed in (`applied_sha`), and read `## Review` against what you see. |
| `superseded` | Confirm that `git show <superseded_by>` contains this card's fix and that the rule or behavior is present in the scope file at HEAD. On a pass, clear the flag. A false claim goes to `triaged` with the flag cleared, a review block and a verdict; its labels and confirmation survive because only the terminal claim was false. `superseded_by` is not a `triage --apply` field, so the stale value remains in frontmatter and the status and verdict are authoritative. |
| `rejected` | Confirm that `## Answer` or the notes record a user decision naming who declined the change and when. On a pass, clear the flag. If the record is absent or ambiguous, leave the status at `rejected`, clear the flag and park it on the user with a review block and verdict; there is no send-back from a user decision without the user. |

Then write the verdict in one `triage --apply` call:

- **Pass** → `"needs_review": ""` and `"verdict": "pass — <what you checked>"`. For a `reviewed` card that call also carries `"status": "verified"` and `"verified_at": "<date — what the command returned>"`.
- **Send back** → the status one phase back (`triaged` → `"recorded"`, `planned` → `"triaged"`, `reviewed` → `"applied"`), `"needs_review": ""`, `"blocked_on": "review: <one line>"`, and `"verdict": "<what is wrong, and what would fix it>"`. The card parks on the user; clearing the block sends the runner round again with your verdict as its brief. Do not fix it yourself — the point of the split is that the checking run judges and the doing run does.
- **The validation plan failed on a `reviewed` card** → `"status": "failed"`, the output under `"verdict"`, no flag. `failed` goes back to `planned`, not to the start: the problem is still real and still triaged, only the fix was wrong. Do not revert — show the `git revert <applied_sha>` that would, and let the user choose.

A check is not a re-triage. If the labels are defensible, pass them; the
send-back is for a claim that does not hold at HEAD, a patch that does not
apply or does more than its plan, a validation plan that proves nothing.

## Step 7 — Apply, then verify (`MODE=drain`)

For each suggestion at `status: approved`:

1. Confirm the target is `writable` in config. Project targets are read-only by default; refuse and say so.
2. Confirm the patch's own files are clean: `git -C <skills> status --porcelain -- <paths the patch touches>` must be empty, and nothing may be staged. Untracked files elsewhere are fine — the server stages only the patch's paths, so they cannot ride into the commit. Uncommitted work in a file the patch touches would be clobbered and make `git revert` stop being a clean undo; refuse and say which files.
3. `git apply --index` the patch (staging exactly the paths it touches — a patch cannot then be half-committed by a wrong `git add`), run the script's `--self-check` if there is one.
4. Commit one suggestion per commit:

```
kaizen(<type>/<objective>): <scope or slug>

<one line on what changed and why>

Kaizen-Suggestion: <suggestion id>
```

5. Once codex has reviewed the landing and claude has verified it (below), the whole walk stamps in one call — it checks every transition and every phase requirement against the spec, all-or-nothing, and it passes through `reviewed`, so it refuses a card with no `## Review`:

```bash
kaizen drain --apply - <<'JSON'
[{ "id": "<suggestion id>", "sha": "<commit>", "verified_at": "<date — what the validation returned>" }]
JSON
```

`git log --grep=Kaizen-Suggestion` is then the applied-changes ledger, for free. Rollback is `git revert <sha>`.

### Step 7a — Review the landed change (`MODE=run`, codex)

`applied` means git accepted a diff. It does not mean the problem is fixed, and
treating the two as the same thing is why a queue can fill with landed changes
nobody ever checked. So a landed card is the runner's work again before it is
the reviewer's.

For each card at `applied`, gather the mechanical evidence first. The command
accepts only an `applied` card with `applied_sha` and a fenced validation
command. It checks out that exact commit, installs target dependencies when
needed, runs validation there, and returns JSON shaped as
`{ id, sha, diff, validation: { command, exitCode, stdout, stderr } }`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" review --dry <id>
```

Read `diff` against `## Plan` and decide whether the landing is shippable; the
helper supplies facts, not that judgement. If it exits nonzero, keep the card
at `applied`, report its JSON or stderr, and fix a transient cause before
rerunning. Do not reconstruct the evidence manually or advance a failed
validation. Once it passes, write in one call `"review": "<what the commit
does, whether it matches the plan, what the validation returned, anything you
would not have shipped>"`, `"status": "reviewed"` and `"needs_review":
"claude"`. This is the one flag that names claude; the server hands the card to
it from there.

### Then verify — the drain is not finished at `reviewed`

claude's Step 6b on a `reviewed` card: the validation plan runs again under the
reviewer's own eyes, and the card ends `verified` with `verified_at` — the only
status that claims the loop closed — or `failed`.

A validation plan that cannot be run — because it named something vague — is
itself a finding. File it against the plan step rather than marking the
suggestion verified on the strength of the diff looking correct.

## Step 8 — Run the rubric against kaizen itself

Kaizen is not exempt from the loop it runs. Once per **backlog** pass of the
reviewer — skip this step when `TARGET` is set, and skip it as the runner:
kaizen judging kaizen is the checker's job, not the runner's, and the server
fans runs out — three
once ran this rubric against the same tree within a minute. Its result says
nothing about the one card a fenced pass is deciding, and `doctor --file` from
concurrent passes races on the date-keyed filename.

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
as any other suggestion, so it queues and scores alongside them. There
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
Reflection or a final residue audit must not become cleanup: remove a worktree
only when its exact path matches the allocation receipt retained by this run.
Report every other worktree as foreign and leave it untouched.
Reflection writes only to the configured feedback directory. Never turn its
lesson into a direct target-tree edit during the same runner pass.

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
- `scope:` — the path the skill or script **should** live at. That is what marks three separate reports of the same missing skill as one fix.
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
- **Nothing to do.** Say so in one line and stop. A pass that reports nothing is a good outcome, not a failed run.

## Notes

- Suggestion files are the only state. There is no index to rebuild and nothing to keep in sync.
- The scanner is deterministic; if a number looks wrong, the fix belongs in `scripts/lib/`, not in a workaround here.

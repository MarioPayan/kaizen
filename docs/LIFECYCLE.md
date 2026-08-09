<!-- DO NOT EDIT. Generated from lifecycle.json by `kaizen docs`. Edit that file, not this one — `kaizen docs --check` fails when this drifts. -->

# The suggestion lifecycle

A suggestion moves through six phases. It rests in exactly one status between
each, so "where is this" always has one answer.

## Phases

| #   | Phase       | Who runs it                    | Attended | Comes to rest at |
| --- | ----------- | ------------------------------ | -------- | ---------------- |
| 1   | **Capture** | the skill that hit the problem | no       | `recorded`       |
| 2   | **Triage**  | kaizen, unattended             | no       | `triaged`        |
| 3   | **Plan**    | kaizen, unattended             | no       | `planned`        |
| 4   | **Decide**  | you                            | yes      | `approved`       |
| 5   | **Apply**   | the server                     | no       | `applied`        |
| 6   | **Verify**  | kaizen, unattended             | no       | `verified`       |

### Capture

A skill finishes a run, notices something that cost it, and files it. Write down everything the next reader will need, because they were not there. Capture is cheap and never blocks the run that files it.

Cannot be left until these are present: `context`, `suggestion`, `rationale`, `evidence`, `severity`.

### Triage

Decide whether the problem is real, still present, and correctly described — then label it. Re-read the scope file at HEAD before anything else: months pass between capture and triage, and a suggestion whose fix already landed is superseded, not work. Labelling changes no code, so it needs no approval.

Cannot be left until these are present: `type`, `objective`, `scope`, `rung`, `effort`, `confirmed_at`.

### Plan

Turn a validated problem into something that can be approved: the change itself as a real patch, and the validation plan that will prove it worked. A plan without a validation plan is a guess with a diff attached.

Cannot be left until these are present: `plan`, `validation`, `patch`.

### Decide

The only attended phase. You are shown the change and the validation plan together and say yes or no. Nothing reaches this phase without both, which is the point: approving an idea nobody has written is how a queue fills with decisions that cannot be drained.

### Apply

Land the patch as one commit per suggestion, into a clean tree, on a writable target. The commit carries a Kaizen-Suggestion trailer, so `git log --grep=Kaizen-Suggestion` is the ledger for free and `git revert <sha>` is the undo.

Cannot be left until these are present: `applied_sha`.

### Verify

Run the validation plan written during planning against the change that actually landed. This is the phase that makes the loop closed rather than open: without it, applied means nothing more than the diff did not conflict.

Cannot be left until these are present: `verified_at`.

## Statuses

| Status       | Short | Phase   | Also written as | What it means                                                                                                                                                  |
| ------------ | ----- | ------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recorded`   | `rec` | capture | `new`           | Filed with its context and waiting for triage. Nobody has judged it yet.                                                                                       |
| `triaged`    | `tri` | triage  | —               | Confirmed to still be a real problem at HEAD, and labelled. Ready for someone to plan a fix.                                                                   |
| `planned`    | `pln` | plan    | `proposed`      | A patch and a validation plan both exist. This is the only status that can be approved.                                                                        |
| `approved`   | `apr` | decide  | —               | You said yes to a specific patch. It lands on the next drain.                                                                                                  |
| `applied`    | `apl` | apply   | —               | Landed as a commit. The server sets this after git succeeded — it cannot be set by hand.                                                                       |
| `verified`   | `ver` | verify  | —               | The validation plan passed against the landed change. Done, and provably so.                                                                                   |
| `failed`     | `fai` | verify  | —               | It landed and the validation plan did not pass. Goes back for a new plan rather than starting over — the problem is still real and still triaged.              |
| `rejected`   | `rej` | decide  | —               | You said no. The file stays on disk as a record and stops being offered.                                                                                       |
| `superseded` | `sup` | triage  | —               | The problem is gone — already fixed by other work, or the file it named no longer exists. Records where the fix actually lives so the finding is not re-filed. |

The "also written as" column is the previous vocabulary. Files recorded before
this spec still carry those names and are read as the status they map to.

## Transitions

```
recorded   → triaged | rejected | superseded
triaged    → planned | rejected | superseded
planned    → approved | rejected
approved   → applied
applied    → verified | failed
verified   → (terminal)
failed     → planned
rejected   → (terminal)
superseded → (terminal)
```

`approved` is reachable only from `planned`, so an approval with no plan behind it
cannot be written down.

## The item format

| Field          | Required by | Where it lives                | What goes in it                                                                                                                                                                                                                    |
| -------------- | ----------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context`      | Capture     | a `## Context` section        | What happened, in enough detail that someone who was not there can judge it months later. The run, the inputs, the command, the actual error text.                                                                                 |
| `suggestion`   | Capture     | a `## Suggestion` section     | What to change. A concrete edit where one is obvious, not a wish.                                                                                                                                                                  |
| `rationale`    | Capture     | a `## Why it matters` section | What it costs to leave alone, and how often. This is what scoring reads.                                                                                                                                                           |
| `evidence`     | Capture     | a `## Evidence` section       | The receipts: command output, file:line, a PR or run URL. Triage re-checks the claim against HEAD and cannot do that from a summary.                                                                                               |
| `severity`     | Capture     | frontmatter                   | low, medium or high. Leave blank rather than guessing — a wrong label outranks a missing one in the queue, which is worse.                                                                                                         |
| `type`         | Triage      | frontmatter                   | determinism, structural, behavioral, content, tooling or hygiene.                                                                                                                                                                  |
| `objective`    | Triage      | frontmatter                   | bug, guardrail, feature, performance, clarity or debt.                                                                                                                                                                             |
| `scope`        | Triage      | frontmatter                   | The file the fix lands in. The strongest clustering signal there is — name the path a script would live at even when it does not exist yet.                                                                                        |
| `rung`         | Triage      | frontmatter                   | 0-3 on the determinism ladder. A rung of 2 or 3 must say in one sentence why the rung below does not work.                                                                                                                         |
| `effort`       | Triage      | frontmatter                   | S, M or L.                                                                                                                                                                                                                         |
| `confirmed_at` | Triage      | frontmatter                   | When the problem was last confirmed to still exist at HEAD, and against which commit. Without this there is no way to tell a live finding from one the codebase already moved past.                                                |
| `plan`         | Plan        | a `## Plan` section           | The change, concretely: which files, which edits, and what deliberately stays out.                                                                                                                                                 |
| `validation`   | Plan        | a `## Validation` section     | How we will know it worked — the command to run and the result that counts as passing. A self-check for a rung-1 script, a test for a code change, a named observable behaviour otherwise. This is what the verify phase executes. |
| `patch`        | Plan        | a sibling `.patch` file       | The real diff, stored beside the suggestion, passing `git apply --check`. A described patch is not a patch.                                                                                                                        |
| `applied_sha`  | Apply       | frontmatter                   | The commit. Set by the server, never by hand.                                                                                                                                                                                      |
| `verified_at`  | Verify      | frontmatter                   | When the validation plan was run against the landed change, and what it returned.                                                                                                                                                  |

## The determinism ladder

Every fix is placed on a rung, and may not sit higher than necessary. A fix at
rung 2 or 3 has to say in one sentence why the rung below does not work.

| Rung  | What it is          | Costs            | Why                                                                               |
| ----- | ------------------- | ---------------- | --------------------------------------------------------------------------------- |
| **0** | Harness enforces it | 0 tokens         | A hook, a permission rule, a CLAUDE.md line. Cannot drift, cannot be skipped.     |
| **1** | A script decides    | one Bash call    | Shell returning a verdict. Testable, greppable, identical every run.              |
| **2** | A written rule      | tokens every run | Prose re-read and re-interpreted every run. Fine when the input genuinely varies. |
| **3** | Left to reasoning   | tokens + drift   | Nothing written down. Where most recorded failures came from.                     |

### What capture writes

```markdown
---
severity:
---

## Context

## Suggestion

## Why it matters

## Evidence
```

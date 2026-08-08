# skill-reflect

Universal post-skill improvement reflection. Read by a skill at its final step. Captures concrete improvements observed during this run so the skill itself can get better over time.

This is a library module. **No frontmatter.** Never invoked directly — only via the calling phrase from another skill's final step.

Ships with kaizen so that a fresh install has a capture layer rather than assuming one exists. If a skills tree already has its own copy, keep that one and add the fields below to it — the file path is what other skills reference, and changing it would break every call site.

---

## Inputs

- `SKILL_NAME` — slug of the skill that just ran
- `OUTCOME` — one of: `complete`, `partial`, `errored`
- `WHAT_RAN` — 1–2 sentences describing what this invocation actually did, not what the skill is for in general

## Outputs

- `REFLECTION_PATH` — absolute path of the file written, or empty if nothing was written

---

## When to write a suggestion

Any one of these is enough.

- A step's instructions were ambiguous or sent you down a wrong path.
- A piece of context was missing or hard to reach.
- The user had to clarify something the skill should have inferred.
- An API or tool returned something the skill did not account for.
- The skill took noticeably longer than the work required.
- An edge case was not covered.
- A shared module's contract felt wrong — awkward inputs, or the split is in the wrong place.
- **A step was pure mechanics.** You followed a fixed sequence of commands and read the result, with no judgement involved. That step is a script waiting to be written, and this is the highest-value thing to report — see below.

## When to skip

- The run was uneventful and every step held.
- The issue is already documented in the skill.
- The issue was a one-off from external state — a flaky API, a network blip.

---

## The mechanics trigger

Most recurring failures come from procedure written as prose. Prose gets re-read and re-interpreted on every run, so it drifts; a script does not.

Ask of each step you executed: *did I decide anything, or did I follow instructions?* If the answer is "followed", say so explicitly and set `rung: 1`. Name the commands. A suggestion that says "steps 4–6 are a fixed sequence of four git commands and a comparison; they should be one script returning a verdict" is worth more than any wording improvement.

---

## Output destination

```
<feedback-dir>/<SKILL_NAME>/<YYYY-MM-DD>-<short-topic-slug>.md
```

`<feedback-dir>` is the `feedback` path configured for this skills tree — by convention `skills-feedback/` beside the skills directory. Create the tree as needed. One file per suggestion; never overwrite.

The slug is 3–5 words capturing the topic, lowercased and dash-separated: `cwd-resolution-bug`, `slow-comment-fetch`, `missing-edge-case-binary-files`.

---

## File structure

```markdown
---
skill: <SKILL_NAME>
date: <YYYY-MM-DD>
outcome: <OUTCOME>
severity: low | medium | high
status: new
type: determinism | structural | behavioral | content | tooling | hygiene
objective: bug | guardrail | feature | performance | clarity | debt
scope: <the file the fix lands in>
rung: 0 | 1 | 2 | 3
effort: S | M | L
---

## Context

<What the skill was doing, in 1–2 sentences. Concrete: name the step, the input, the unexpected behaviour.>

## Suggestion

<The improvement. Name the step number, the file, the exact wording or behaviour change.>

## Why it matters

<1–2 sentences: time saved, errors avoided, clarity gained, blast radius reduced.>
```

Field guidance:

- `severity` — `high` caused an error, wrong output, or needed the user to step in; `medium` slowed the run or forced a workaround; `low` is polish. Bias low; `high` should mean something actually broke.
- `type` — `determinism` whenever the fix moves a step down the ladder. That label is what surfaces it as a conversion candidate, so use it rather than `behavioral` when both would fit.
- `scope` — the file the fix lands in. Fill this in even when it seems obvious: it is the strongest signal for grouping this with the others like it.
- `rung` — where the fix belongs, not where the problem currently lives.

Leave a field blank rather than guessing. Blank reads as "needs triage"; wrong reads as "already assessed" and floats a bad entry up the queue.

---

## Steps

1. **Reflect** against the trigger list using what this run actually surfaced. Do not pattern-match on the skill's general purpose.

2. **Decide** whether to write. A vague "could be better" is not worth a file.

3. **Dedup.** Scan the skill's feedback folder for a file whose topic overlaps — 3+ words in common, or the same point in different words. If one exists, append to it rather than creating a duplicate:

   ```markdown
   ## Recurrence — <YYYY-MM-DD>
   <One sentence on this instance. Add anything the original does not capture.>
   ```

   Recurrence count is how the queue knows what keeps happening. Appending is not a lesser outcome than a new file — it is often the more valuable one.

4. **Write** the file, or append the recurrence section.

5. **Print one line** as the final output:
   - `Reflection: <REFLECTION_PATH>`
   - `Reflection: appended to <existing path>`
   - `Reflection: no suggestion.`

The single line keeps this step light in the visible output. The substance lives in the file.

---

## Edge cases

- **Several suggestions in one run.** One file each, separate slugs. Dedup applies per suggestion.
- **The skill errored before this step.** This module does not run. That is expected; the skill's own error path surfaces it.
- **Cross-skill suggestions.** File under the skill that surfaced it and name the shared module in the body. Clustering will find the others.

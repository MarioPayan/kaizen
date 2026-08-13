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

Two sets of fields, and the split is the point. **You write the six you observed.
Triage assigns the four that are judgement calls about the fix.** Earlier versions
of this file listed them all together and invited you to leave any of them blank;
across 66 filed suggestions that produced `scope` 0 times and a taxonomy 5 times.
Do not treat the second block as yours to fill.

The full contract — every field, which phase needs it, and whether it is
frontmatter or a `## Heading` — is generated from `lifecycle.json` into
`docs/LIFECYCLE.md`. This template is that contract's capture half; if the two
ever disagree, the spec is right.

```markdown
---
# You write these. You just ran; you observed all five.
skill: <SKILL_NAME>
date: <YYYY-MM-DD>
outcome: <OUTCOME>
severity: low | medium | high
scope: <the file the fix lands in>
status: recorded
---

## Context

<What the skill was doing, in 1–2 sentences. Concrete: name the step, the input, the unexpected behaviour.>

## Suggestion

<The improvement. Name the step number, the file, the exact wording or behaviour change.>

## Why it matters

<1–2 sentences: time saved, errors avoided, clarity gained, blast radius reduced.>

## Evidence

<The receipts. The command and its actual output, a file:line, a PR or run URL.
Paste, do not paraphrase.>
```

`type`, `objective`, `rung` and `effort` are **not yours to write.** They are
assigned by `/kaizen:triage`, which reads the whole corpus and can see which
suggestions share a fix. Omit them entirely.

Field guidance for the five that are yours:

- `severity` — `high` caused an error, wrong output, or needed the user to step in; `medium` slowed the run or forced a workaround; `low` is polish. Bias low; `high` should mean something actually broke.
- `scope` — **required, and the one worth slowing down for.** The single file the fix lands in. If the fix is a script that does not exist yet, name the path it would live at. This is the strongest grouping signal there is: it is what turns nine separate "the remote isn't always origin" reports into one decision instead of nine.
- `outcome` — how *this run* ended, not how bad the finding is.
- `evidence` — the receipts, pasted rather than described. Triage re-reads the
  scope file at HEAD months later to decide whether the problem is still real,
  and it cannot do that from a summary. "the call 404s" needs the call and the
  404; "the flag is unsupported" needs the error text. This is the field that
  makes a suggestion still auditable when nobody remembers the run.

`severity` is the only one you may leave blank, and only when the Context genuinely
does not say. Blank reads as "needs triage"; wrong reads as "already assessed" and
floats a bad entry up the queue. `scope` blank is not an acceptable outcome —
`kaizen validate` reports it as a problem, because a suggestion nobody can group
is a suggestion nobody will fix.

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
- **Cross-skill suggestions.** File under the skill that surfaced it and name the shared module in the body. Its scope names where the one fix lands, alongside the others that share it.

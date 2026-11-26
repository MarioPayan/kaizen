# skill-reflect

Capture concrete problems discovered while a skill runs so a later `/kaizen`
session can repair them. This is a library module with no frontmatter and is
never invoked directly.

## Inputs and output

- `SKILL_NAME`: skill slug
- `OUTCOME`: `complete`, `partial`, or `errored`
- `WHAT_RAN`: one or two concrete sentences about this invocation
- output `REFLECTION_PATH`: the written file, or empty

Write when instructions were ambiguous, context was missing, the user had to
clarify, a tool behaved unexpectedly, an edge case was absent, or a mechanical
procedure should become a script. Skip uneventful runs, already documented
issues, and one-off external failures.

## Capture contract

One finding is one file at
`<feedback>/<SKILL_NAME>/<YYYY-MM-DD>-<short-topic-slug>.md`, never overwritten,
in the feedback directory configured for the skills tree. `capture --write`
(step 3) writes it in this shape; you supply the fields and the body.

```markdown
---
skill: <SKILL_NAME>
date: <YYYY-MM-DD>
outcome: <OUTCOME>
severity: low | medium | high
scope: <target-relative or absolute file the fix lands in>
status: open
---

## Context

<What ran and what went wrong.>

## Suggestion

<The exact behavior or instruction change.>

## Evidence

<Commands and output, file:line, or run URL.>
```

Severity is `high` for wrong output, an error, or user intervention; `medium`
for delay or workaround; `low` for polish. Scope is required. Name a proposed
script path when the file does not exist yet.

## Steps

1. Reflect on this run, not the skill's general purpose.
   Nothing worth a capture: skip to step 4 with `Reflection: no suggestion.`
2. Choose a 3–5 word lowercase dash-separated slug, the scope and the severity.
3. Write the body (an optional `# <title>` line, then the three `##` sections
   above, no frontmatter) to a file, and run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" capture --write \
     --skill "$SKILL_NAME" --scope '<scope>' --slug '<slug>' \
     --severity <severity> --outcome "$OUTCOME" --context-file <body-file>
   ```

   (`--context-file -`, or no flag, reads the body from stdin.) It runs the
   duplicate check across every skill and target. On an open match, or a fixed
   lookalike (a problem that came back after its fix, which `kaizen list` then
   resurfaces), it appends the body to that file under
   `## Recurrence — <YYYY-MM-DD>`; otherwise it writes the new file. It prints
   the one line step 4 needs. On invalid input it exits 1 and names the problem
   (a missing flag, a bad slug, an empty section): fix it and rerun.

   Shared scope alone does not make a duplicate; one file can hold unrelated
   rules. When an open item on the same scope may be a different failure, run
   `capture --check` with the same `--skill`, `--scope` and `--slug` first;
   if its `match` is not this failure, add `--new` to `capture --write`. If the
   CLI is unavailable, compare normalized scope and three shared slug words in
   the feedback folders by hand, then write the file or the Recurrence yourself.
4. Print exactly one final line: `Reflection: <path>`,
   `Reflection: appended to <path>`, or `Reflection: no suggestion.`

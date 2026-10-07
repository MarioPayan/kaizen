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

Write one finding to
`<feedback>/<SKILL_NAME>/<YYYY-MM-DD>-<short-topic-slug>.md`. Never overwrite.
The feedback directory is the configured one for the skills tree.

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
2. Choose a 3–5 word lowercase dash-separated slug and the required scope.
3. Before writing, run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" capture --check \
     --skill "$SKILL_NAME" --scope '<scope>' --slug '<slug>'
   ```

   It always returns one JSON object. If `match` names the same failure, append:

   ```markdown
   ## Recurrence — <YYYY-MM-DD>

   <What this instance adds.>
   ```

   Shared scope alone is not enough; one file can contain unrelated rules. If
   the check is unavailable, manually compare normalized scope and three shared
   slug words in the skill's feedback folder.
4. Write the new file or recurrence.
5. Print exactly one final line: `Reflection: <path>`,
   `Reflection: appended to <path>`, or `Reflection: no suggestion.`

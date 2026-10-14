---
name: kaizen
description: Repair captured skill problems in one focused local session
---

# Kaizen

Use this workflow when invoked as `/kaizen`. Kaizen collects work; you perform
the repair directly.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" list --by scope`. JSON is
   the default. If the user named a skill, scope, or suggestion, restrict the
   session to that request; otherwise start with the largest or most severe
   groups.

2. Work one scope group at a time. Read every grouped suggestion and read the
   scope file on the target's default branch (`git show origin/HEAD:<path>`
   when the checkout is behind it or on another branch). For each item decide:

   - fixed already: close it as fixed after identifying the commit;
   - covered: another item or commit already handles it; close it with
     `--dropped 'covered by <id|sha>'`;
   - drop: it is one-off, incorrect, obsolete, or not worth encoding;
   - re-scope: it belongs to another file; edit its `scope:` frontmatter
     line and leave it open for that group;
   - fix: it describes a problem that still exists.

   Absence on a stale checkout proves nothing: a fixed or obsolete verdict
   names the commit on the default branch that fixed or removed it.

3. Make one coherent change per scope, at the lowest rung that works:

   - a hook, permission, or repository rule when enforcement can be automatic;
   - a script with a verdict when the procedure is mechanical;
   - skill prose only when inputs vary and judgement is required;
   - unaided reasoning only for genuinely novel cases.

   Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" doctor` before and after
   the change: it must not add a `budget-exceeded` finding. A hook or script beats repeated prose. A
   sibling `.patch` is only an old proposal: reuse it only after checking that it
   still applies and still solves the current findings.

4. Validate with the target repository's checks and any changed script's
   `--self-check`. Do not weaken tests to make the change pass.

5. Get approval before anything is committed or closed. Present every verdict
   (each planned change with its diff and the exact suggestion ids it closes,
   plus each drop, covered and re-scope decision) and wait for the answer.
   Follow the user's artifact rules for this (for Mario,
   `~/.claude/skills/rules/artifacts.md`: a decision deck, with one confirm
   item per change and one per closure batch). Only a scope of three items or
   fewer may use a plain yes/no in the terminal. Questions about *how* to do
   the work are not approval of *what* it changes. Write fixes in English,
   even when the suggestion was not.

   Once approved, commit locally, never push. Add one trailer per item:

   ```text
   Kaizen-Suggestion: <id>
   ```

6. After the commit exists, close fixed items:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" close <id>... --fixed <sha>
   ```

   Close rejected items with a specific reason:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" close <id> --dropped '<reason>'
   ```

   Batch decisions may use `close --json <file|->` with
   `[{"id":"...","fixed":"<sha>"}]` or a `dropped` reason. The command
   validates the entire batch first; on an error, correct the input and rerun it.

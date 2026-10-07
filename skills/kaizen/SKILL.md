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
   scope file at `HEAD`. For each item decide:

   - fixed already: close it as fixed after identifying the commit;
   - drop: it is one-off, incorrect, obsolete, or not worth encoding;
   - fix: it describes a problem that still exists.

3. Make one coherent change per scope, at the lowest rung that works:

   - a hook, permission, or repository rule when enforcement can be automatic;
   - a script with a verdict when the procedure is mechanical;
   - skill prose only when inputs vary and judgement is required;
   - unaided reasoning only for genuinely novel cases.

   Respect configured `budgets`. A hook or script beats repeated prose. A
   sibling `.patch` is only an old proposal: reuse it only after checking that it
   still applies and still solves the current findings.

4. Validate with the target repository's checks and any changed script's
   `--self-check`. Do not weaken tests to make the change pass.

5. Show the user a concise diff summary and the exact suggestion ids the change
   will close. Commit locally, never push. Add one trailer per item:

   ```text
   Kaizen-Suggestion: <id>
   ```

   Optionally ask Codex for a second-opinion review of the diff before the
   commit when the change is broad or subtle.

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

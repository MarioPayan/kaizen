---
name: kaizen
description: Repair captured skill problems in one focused local session
---

# Kaizen

Use this workflow when invoked as `/kaizen`. Kaizen collects work; you perform
the repair directly.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" list --by scope`. JSON is
   the default. If the user named a skill, scope, or suggestion, the session's
   scope is that request; otherwise it is every listed item. Work the largest
   or most severe groups first. An item with `status: fixed` and a
   `recurredAfterFix` object is a fix that did not hold: its listed recurrence
   dates come after the fix date.
   Treat it as open, find why the earlier fix missed it, and close it again
   with `--fixed <sha>` once a new commit exists.

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

5. Get approval before anything is committed or closed. The review covers
   every item in the session's scope, not only those with a planned change:
   each listed item (open, or fixed with `recurredAfterFix`) appears exactly
   once with its id and one verdict: fix (with its diff), fixed already,
   covered, drop, re-scope, or defer. No item may be omitted: defer is how an
   item stays open without a re-scope. Group the entries by category (the item's
   `skill`) and show the category as the group heading. Follow the user's
   artifact rules for this (for Mario, `~/.claude/skills/rules/artifacts.md`:
   a decision deck, with one confirm item per change and one per closure
   batch). Before presenting it, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" list --missing-from <deck-file>`
   on the deck's source; for an unrestricted session it must exit 0, and in a
   restricted one every id it reports must lie outside the scope. Only a scope
   of three items or fewer may use a plain yes/no in the terminal, still with
   one verdict per item. Questions about *how* to do the work are not approval
   of *what* it changes. Write fixes in English, even when the suggestion was
   not.

   Once approved, commit locally; push only through step 7. Add one trailer
   per item:

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

7. Offer the push. If the repository holding the skills tree is on `master`
   and ahead of its upstream, list `git log --oneline @{u}..` and ask for a
   one-word go; approval in step 5 does not cover it. On a go, run `git push`
   as a fast-forward. Never force-push or `pull --rebase`: if the push is
   rejected because the remote moved, stop and report it for the user to
   reconcile. Without a go, end by saying the clone is N commits ahead and
   (for Mario) the session-start hook will keep warning until it is pushed.

---
name: kaizen
description: Repair captured skill problems in one focused local session
---

# Kaizen

Use this workflow when invoked as `/kaizen`. Kaizen collects work; you perform
the repair directly.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" list --by scope --text`
   as the index: one `<scope key> (<count>)` line per group, then one
   `[severity] <id>` line per item. If the user named a skill, scope, or
   suggestion, the session's scope is that request; otherwise it is every
   listed item. Work the largest or most severe groups first. An item marked
   `recurred after fix <date>` is a fix that did not hold: its recurrences are
   dated after that fix. Treat it as open, find why the earlier fix missed it,
   and close it again with `--fixed <sha>` once a new commit exists.

2. Work one scope group at a time. Read the group with
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" show --scope '<scope key>'`,
   which prints each item's whole file, Recurrence sections included, so do
   not open the suggestion files again. Read the
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

5. Get approval before anything is committed or closed (only the proposal
   branches of a [large queue](#large-queue) may hold commits before it). The review covers
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
   per item, in the message's last paragraph together with any other trailer
   (`Co-Authored-By:` and the like) and no blank line between them: git reads
   only the last paragraph as trailers, so a separated `Kaizen-Suggestion:`
   line is invisible to `git log --format='%(trailers:key=Kaizen-Suggestion)'`.

   ```text
   Kaizen-Suggestion: <id>
   Co-Authored-By: <co-author>
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

## Large queue

When the scope is too big for one session (dozens of groups), an orchestrator
may fan out workers, each in its own worktree on a proposal branch. Steps 1–7
still hold, with these rules:

- Cluster groups by file ownership so no two workers edit one file. Name one
  owner for each file several clusters touch (a shared rules file, an index);
  the other workers put the text they want there in their report instead of
  editing it. Plan a reconciliation pass on the merged branch from the start,
  where the owner applies that text.
- Workers may commit proposals on their branch before approval; the step 5
  review shows those commits. Approval still gates everything that lands:
  nothing is merged into the target's branch, closed or pushed before it.
  Only the orchestrator closes items, after the approved merge, with the sha
  that landed on the target's branch, never a proposal-branch sha.
- Brief every worker with the target repository's instruction files by a path
  checked to exist, and with the trailer rule from step 5.
- A target rule a worker cannot meet (a paid model-behaviour replay per
  behaviour fix, a check that needs credentials) is not skipped silently: the
  worker writes the case or command without running it and reports it, and
  the review lists each unrun case for the user to run or waive.
- A pre-commit hook that runs the full gate costs commits × worktrees: have
  workers commit once per scope group, and stagger them when the machine's
  load passes its core count.

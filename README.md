# kaizen

Your Claude Code skills, getting better every time they stumble. When a skill hits friction, it
writes the problem down; one `/kaizen` session later, the fix is committed and the item is closed.

![A terminal across Claude Code sessions: a release-notes skill fails to find its changelog, checks kaizen for a duplicate and writes one suggestion file; the next session opens with "kaizen: 1 open"; /kaizen lists the backlog by the file to fix, edits the skill, commits with a Kaizen-Suggestion trailer and closes the item; the session after that opens with "kaizen: 0 open"](docs/images/loop.svg)

## What you are looking at

![A suggestion file, annotated: its path is the feedback folder, the skill and a dated slug, and its id is target, skill and file; the frontmatter holds skill, date, outcome, severity, the scope file the fix lands in, and a status that is only open, fixed or dropped; Context, Suggestion and Evidence sections follow; later a Recurrence section can be appended and kaizen close records the fix sha or the reason it was dropped](docs/images/suggestion.svg)

## Get it

In Claude Code:

```text
/plugin install kaizen --marketplace MarioPayan/kaizen
```

On a Claude Code older than 2.1.275, add the marketplace first: `/plugin marketplace add MarioPayan/kaizen`,
then `/plugin install kaizen@kaizen`. From a shell, the same two steps are `claude plugin marketplace add` and
`claude plugin install`.

That gives you `/kaizen` and the one-line count at session start. Tell it where your skills live in
`~/.claude/kaizen/config.json`:

```json
{
  "version": 1,
  "targets": [{ "name": "user", "skills": "~/.claude/skills", "feedback": "~/.claude/skills-feedback" }]
}
```

and create the feedback folder (`mkdir -p ~/.claude/skills-feedback`). Then let your skills capture: put the
CLI on your `PATH` and copy the capture contract next to your skills.

```bash
mkdir -p ~/.local/bin ~/.claude/skills/_lib
ln -s ~/.claude/plugins/marketplaces/kaizen/scripts/cli.mjs ~/.local/bin/kaizen
sed 's|node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs"|kaizen|' \
  ~/.claude/plugins/marketplaces/kaizen/skills/_lib/skill-reflect.md > ~/.claude/skills/_lib/skill-reflect.md
```

The `sed` swaps the plugin-only path for the `kaizen` command, because `CLAUDE_PLUGIN_ROOT` is set only inside
the plugin. Last, end each skill you want watched with a step like:

> Apply `~/.claude/skills/_lib/skill-reflect.md` with `SKILL_NAME=release-notes`, `OUTCOME` = `complete`,
> `partial` or `errored`, and `WHAT_RAN` = one sentence about this run.

**Or ask Claude Code:**

> Install kaizen from github.com/MarioPayan/kaizen and wire it into my skills as its README says

## Why

|                                    |                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Caught where it happens**        | The skill that stumbled writes it down in its last step, while the evidence is still in context                              |
| **Hard to forget**                 | A SessionStart hook opens every session with one line, `kaizen: 3 open`. No model call; about 80 ms with 500 items open      |
| **One problem, one file**          | `capture --check` searches every skill first, so a repeat becomes a dated `## Recurrence` on the original, not a second file |
| **Fixes that did not hold return** | An item that recurs after its fix commit is listed again, with the dates that prove it                                       |
| **Repaired by file**               | `/kaizen` groups the backlog by the file the fix lands in, and reaches for a hook or a script before adding more prose       |
| **You approve**                    | `/kaizen` asks before it commits, closes or pushes, and every commit names its items in a `Kaizen-Suggestion:` trailer       |
| **Nothing running**                | Markdown files in a folder you choose. No server, daemon, database or UI; no runtime dependencies beyond Node 20             |

The 80 ms is the median of 15 runs of `kaizen status`, the command the session hook runs, over a synthetic
backlog of 500 open items on Node 24 and Linux; a bare `node -e ''` takes about 40 ms on the same machine. The
hook is capped at 5 seconds wherever `timeout` exists, and always exits cleanly.

## A `/kaizen` session

1. Lists the backlog grouped by scope, the file each fix lands in, largest and most severe groups first.
2. Reads each group's suggestions against that file on the default branch, and gives every item one verdict:
   fix, fixed already, covered, drop, re-scope or defer.
3. Makes one change per file, at the lowest rung that works: a hook or rule, then a script, then prose.
4. Runs the target repository's checks and `kaizen doctor`, then shows you every item and diff for approval.
5. Commits with one `Kaizen-Suggestion:` trailer per item, closes the items with the commit sha, and offers the
   push separately.

`kaizen doctor` also watches the files your agent always loads: budgets flag a `CLAUDE.md` that has outgrown
its byte ceiling, and a rule in a budgeted file, tagged `<!-- origin: <slug> -->`, that no capture has
mentioned in 60 days is offered for retirement. Kaizen never removes a rule itself. For a statusline, `kaizen status --bar`
prints the count as `改 ○3`.

## More

- [Commands and configuration](docs/reference.md): every command, the duplicate rules, the doctor checks and
  every config key.
- [Architecture](docs/ARCHITECTURE.md): the two layers and the core modules.
- [The capture contract](skills/_lib/skill-reflect.md) and [the `/kaizen` workflow](skills/kaizen/SKILL.md).

## Development

```bash
npm install
npm run check                    # prettier, eslint, vitest and the plugin version-bump check
python3 tools/readme-images.py   # regenerate docs/images from a real CLI run
```

The README images are generated, not drawn: the script runs the CLI against a throwaway skills tree and
refuses to draw if the capture template, the statuses or the close fields have changed under it.

## Licence

[MIT](LICENSE)

# kaizen

Kaizen traps concrete problems found while a skill runs and collects them for an
agent to repair later in one focused session. It is deliberately not a workflow
engine: there is no server, runner, approval pipeline, or UI.

Each finding is a Markdown file at
`<feedback>/<skill>/<YYYY-MM-DD>-<slug>.md`. Its stable id is
`<target>/<skill>/<filename>`. A sibling `.patch` may contain an old proposal;
agents may reuse it only when it still applies.

Statuses are exactly `open`, `fixed`, and `dropped`. A missing or unknown status
is treated as `open`.

## Commands

```text
kaizen status [--bar]
kaizen list [--by scope|skill] [--target <name>] [--missing-from <file|->] [--json|--text]
kaizen capture --check --skill <name> --scope <path> --slug <slug>
kaizen close <id>... (--fixed <sha> | --dropped "reason")
kaizen close --json <file|->
kaizen doctor
kaizen aliases [--json|--text]
kaizen mine [--days N] [--limit N] [--json|--text]
kaizen prune [--days N] [--dry-run]
kaizen migrate [--dry-run]
```

`list` emits JSON by default for agents. `--text` is the human view. `close` is
all-or-nothing for validation: if any id or disposition is invalid, no item is
changed. JSON close input is an array of objects such as
`[{"id":"user/demo/2026-01-01-example.md","fixed":"abc123"}]`; use a
`dropped` string instead to record a reason.

`list --missing-from <file|->` checks that a review covers the backlog: it
prints the listed ids whose text does not appear in the given file (a deck's
HTML, or a list of ids) and exits 1 while any is missing.

`list` returns open items plus fixed items that **recurred after their fix**,
which carry a `recurredAfterFix` object (`fixedOn`, `source`, `dates`); `close`
accepts those again. The fix date is the first of `closed_at`, the leading
date of `verified_at`, or the committer date of `applied_sha` (else a
sha-shaped `fixed_by`) in the target's repository. A recurrence counts when the
date on its `## Recurrence` heading is strictly later; undated recurrences and
items with no resolvable fix date are never flagged.

`capture --check` looks across every skill and target. Rules, first hit wins:
same skill and normalized scope; same skill and three shared slug words; any
skill with the same resolved scope file and three shared content words (slug
plus `# ` title, stopwords dropped); any skill with three shared content words
covering 60% of the shorter set. `match` only names open items. When nothing
open matches, a fixed lookalike is returned as `fixedMatch`: the capture appends
its `## Recurrence` there, which is what `doctor` and `list` resurface.

`doctor` checks budgets, target roots, orphan feedback folders, incomplete
open items, missing scope files, and also:

- `scope-stale-checkout` (instead of `scope-file-missing`): the scope is absent
  from the checkout but exists on a remote's default branch
  (`refs/remotes/<remote>/HEAD`), so the item is live and the checkout is
  behind or on another branch;
- `recurred-after-fix`: the rule above;
- `memory-path-missing`: a project memory (`<projects>/*/memory/*.md`) names a
  file that does not exist. Relative paths resolve against the project's own
  context (its dir, its working directory and repository, the target
  repository holding it, whose git history also counts, and feedback dirs);
  a path no base knows is skipped;
- `retirement-candidate`: a bullet in a budgeted rule file carries
  `<!-- origin: <slug> -->` but no suggestion in the last 60 days has that
  slug, or a scope resolving to the rule file plus two shared words. A human
  decides; kaizen never removes rules.

`aliases` proposes `scopeAliases` for scopes that point at missing files: from
the git rename history of the target's repository (followed to the newest
name), else for a `_lib/` path the one tracked file with the same basename
under `lib/` or `rules/`. It prints the config block and the unresolved scopes;
it changes nothing.

`mine` is a read-only report of capture candidates; it never files anything.
It reads `/insights` facets and session transcripts (sidechains skipped) and
reports capture recall (friction sessions whose transcript wrote into a
feedback dir), hook blocks per guard and trap ("Blocked by <guard> …" followed
by `- <trap>` lines), human messages that open like a correction in English or
Spanish, and per-skill runs (Skill tool calls and slash commands, timed to the
next human message, with the output tokens in between). Transcript formats are
not a stable API: missing fields are tolerated and `parse` counts unparsed
lines, untimed entries, unreadable files and unparsed facets.

`migrate` converts the old lifecycle fields once. Always preview a real corpus
with `migrate --dry-run` first.

## Configuration

Create `~/.claude/kaizen/config.json` (or set `KAIZEN_CONFIG`):

```json
{
  "version": 1,
  "targets": [
    {
      "name": "user",
      "skills": "~/.claude/skills",
      "feedback": "~/.claude/skills-feedback"
    }
  ],
  "scan": { "enabled": false, "roots": [], "depth": 3 },
  "cadence": { "sessionHook": true },
  "budgets": [{ "path": "~/.claude/CLAUDE.md", "maxBytes": 12000 }],
  "sources": { "projects": "~/.claude/projects", "facets": "~/.claude/usage-data/facets" }
}
```

Targets name the skills tree and its feedback directory. A target may add
`scopeAliases`, a map from old scope paths to new ones (a key ending in `/`
maps a directory prefix; the longest key wins); it applies wherever a scope is
resolved: `list` grouping, `doctor`, capture dedupe and retirement matching.
Optional scan roots only discover project `.claude/skills` directories. Budgets
let `doctor` flag always-loaded files that have grown past their byte ceiling;
a budget path may be a single file (symlinks are followed) or a directory
(every file under it). `sources` (both optional, defaults shown) is where
`doctor` reads project memories and `mine` reads transcripts and facets.

The included `SessionStart` hook calls `kaizen status`, which prints only the
open count (`kaizen: 38 open`; `--bar` prints `改 ○38`). Categories (the
`skill` field) stay in the data and show in `list` and the review deck.

## Development

```bash
npm install
npm run check
```

## Licence

MIT

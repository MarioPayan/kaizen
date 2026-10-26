# Architecture

Kaizen has two layers.

- `skills/_lib/skill-reflect.md` defines the capture contract. Skills write one
  Markdown file per finding and run the CLI dedupe check before creating it.
- `packages/core` discovers configured skills and suggestions, parses their flat
  frontmatter and sections, normalizes scopes, resolves paths, and runs the
  small doctor rubric. `scripts/cli.mjs` is the only executable surface.

Core modules:

- `config.mjs`: load, validate and default the config (`targets`,
  `scopeAliases`, `budgets`, `sources`).
- `scan.mjs`: discover skills and suggestions; resolve a scope to a file
  (`scopePath`, applying the target's `scopeAliases`) and to a group key.
- `suggestion.mjs`: parse frontmatter, sections and dated `## Recurrence`
  headings; rewrite frontmatter without touching the body.
- `recurrence.mjs`: the fix date of a fixed item and whether it recurred after.
- `dedupe.mjs`: the capture-time duplicate rules (`capture --check`).
- `aliases.mjs`: propose `scopeAliases` from git renames.
- `doctor.mjs` with `memory.mjs` and `retirement.mjs`: the doctor checks.
- `mine.mjs`: the read-only facet and transcript report. It streams each
  transcript line by line and treats every field as optional.

Everything that reads git (`repoRoot`, commit dates, renames, tracked paths)
shells out to `git` read-only; a missing repository degrades to "unknown".

User data stays outside this repository. Configuration defaults to
`~/.claude/kaizen/config.json`; `KAIZEN_CONFIG` overrides it for tests and other
layouts. Suggestions stay under each target's configured feedback directory.

The only states are `open`, `fixed`, and `dropped`. Parsing maps missing or
unknown values to `open`, which lets the migration command inspect legacy files
without hiding them. Suggestion ids remain `<target>/<skill>/<file.md>`.

No component runs an agent or applies a patch. `mine` and `aliases` only
report; turning a candidate into a capture or a config change is a human or
agent decision. `/kaizen` reads the grouped
backlog, edits the scope files directly, validates, commits locally, and then
closes the corresponding captures.

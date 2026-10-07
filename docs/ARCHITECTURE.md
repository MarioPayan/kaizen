# Architecture

Kaizen has two layers.

- `skills/_lib/skill-reflect.md` defines the capture contract. Skills write one
  Markdown file per finding and run the CLI dedupe check before creating it.
- `packages/core` discovers configured skills and suggestions, parses their flat
  frontmatter and sections, normalizes scopes, resolves paths, and runs the
  small doctor rubric. `scripts/cli.mjs` is the only executable surface.

User data stays outside this repository. Configuration defaults to
`~/.claude/kaizen/config.json`; `KAIZEN_CONFIG` overrides it for tests and other
layouts. Suggestions stay under each target's configured feedback directory.

The only states are `open`, `fixed`, and `dropped`. Parsing maps missing or
unknown values to `open`, which lets the migration command inspect legacy files
without hiding them. Suggestion ids remain `<target>/<skill>/<file.md>`.

No component runs an agent or applies a patch. `/kaizen` reads the grouped
backlog, edits the scope files directly, validates, commits locally, and then
closes the corresponding captures.

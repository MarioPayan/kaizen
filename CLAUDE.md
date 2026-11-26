# kaizen — working notes

Read `README.md`, `docs/reference.md` and `docs/ARCHITECTURE.md` before non-trivial changes.

- `npm run check` runs formatting, lint, tests and `version:check`.
- Bump `version` in `.claude-plugin/plugin.json` (and both `package.json`s)
  with any change under `scripts/`, `skills/`, `hooks/`, `commands/` or
  `packages/core/src/`: `claude plugin update` refreshes an install only on a
  new version. `version:check` fails until the bump exists.
- `node scripts/cli.mjs <command>` runs the CLI.
- `@kaizen/core` has zero runtime dependencies.
- Keep statuses to `open`, `fixed`, and `dropped`; missing or unknown means
  `open`.
- Keep ids as `<target>/<skill>/<file.md>` and preserve suggestion bodies when
  rewriting frontmatter.
- Config lives outside the repo; tests isolate it with `KAIZEN_CONFIG`.
- Kaizen collects work. It does not run agents, apply patches, or host a UI.

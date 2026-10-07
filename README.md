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
kaizen list [--by scope|skill] [--target <name>] [--json|--text]
kaizen capture --check --skill <name> --scope <path> --slug <slug>
kaizen close <id>... (--fixed <sha> | --dropped "reason")
kaizen close --json <file|->
kaizen doctor
kaizen prune [--days N] [--dry-run]
kaizen migrate [--dry-run]
```

`list` emits JSON by default for agents. `--text` is the human view. `close` is
all-or-nothing for validation: if any id or disposition is invalid, no item is
changed. JSON close input is an array of objects such as
`[{"id":"user/demo/2026-01-01-example.md","fixed":"abc123"}]`; use a
`dropped` string instead to record a reason.

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
  "budgets": [{ "path": "~/.claude/CLAUDE.md", "maxBytes": 12000 }]
}
```

Targets name the skills tree and its feedback directory. Optional scan roots
only discover project `.claude/skills` directories. Budgets let `doctor` flag
always-loaded files that have grown past their byte ceiling.

The included `SessionStart` hook calls `kaizen status`, which prints the open
count and the skill holding the most open items.

## Development

```bash
npm install
npm run check
```

## Licence

MIT

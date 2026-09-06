# kaizen — working notes for Claude

Read `docs/ARCHITECTURE.md` before non-trivial changes — it maps every module,
route, and invariant. `docs/LIFECYCLE.md` is **generated** from `lifecycle.json`;
edit the JSON, then `npm run docs`.

## Commands

- `npm run check` — docs freshness, prettier, eslint, vitest. Run before done.
- `cd tui && cargo test && cargo clippy --all-targets` — the Rust side.
- `npm run tui` — release build (what `kaizen tui` launches).
- `node scripts/cli.mjs <cmd>` — the CLI itself (`status`, `scan --pretty`, …).

## Rules that hold everywhere

- `lifecycle.json` is the single source for phases/statuses/transitions. Never
  restate its contents in prose or match status names in code — derive from the
  spec (`lifecycle.mjs` in JS, `lifecycle.rs` in Rust).
- `@kaizen/core` has zero runtime dependencies; keep it that way.
- The server stays on 127.0.0.1 — that binding is the security boundary.
- No user-specific paths in the repo. Config lives in `~/.claude/kaizen/`;
  tests isolate via the `KAIZEN_CONFIG` env var.
- The engine decides, the TUI draws: derived facts belong in core, not views.
- Repeated suggestions sharing a scope use one carrier patch; compare every member's dated recurrences before finalizing it.
- Comment style: comments explain _why_, at the density the codebase already
  has. Tests are named as sentences about behaviour.
- When a skill sequences CLI commands, document the CLI's accepted state and
  machine-readable input shape before the command, including failure recovery.
- Validation fences are executable shell source: use shell-safe quoting, and
  single-quote `node -e` programs whose assertions contain Markdown backticks.

---
description: Triage the skill improvement backlog and propose fixes
---

Invoke the `kaizen:kaizen` skill with the Skill tool, passing `$ARGUMENTS` through.
(`kaizen:triage` is this command, not the skill — calling it again loads nothing.)

Arguments, all optional:
- `review` — the checker's pass: take the cards whose `needs_review` names you — codex checks what codex wrote, claude verifies what landed
- `drain` — apply everything the user has already approved
- `report` — read-only summary, propose nothing
- a suggestion id or skill name — limit the pass to that
- none — hand the work to codex through the server (`kaizen dispatch`) and stop; the check chains after it

$ARGUMENTS

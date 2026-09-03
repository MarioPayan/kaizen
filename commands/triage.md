---
description: Triage the skill improvement backlog and propose fixes
---

Invoke the `kaizen:kaizen` skill with the Skill tool, passing `$ARGUMENTS` through.
(`kaizen:triage` is this command, not the skill — calling it again loads nothing.)

Arguments, all optional:
- `review` — the reviewer's pass: check what opencode wrote, verify what landed (this is what the server sends claude)
- `drain` — apply everything the user has already approved
- `report` — read-only summary, propose nothing
- a suggestion id or skill name — limit the pass to that
- none — hand the work to opencode through the server (`kaizen dispatch`) and stop; the check chains after it

$ARGUMENTS

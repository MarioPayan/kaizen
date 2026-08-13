---
description: Set up kaizen — choose which skills directories to watch
---

Run the interactive setup:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" init
```

It looks for skills in the usual places, asks before adding any of them, and asks
separately about scanning project repositories. Nothing is assumed about this
machine's layout.

Afterwards, report what it found: how many skills and how many
suggestions. If it reported warnings about missing paths, surface them — those are
configuration problems, not noise.

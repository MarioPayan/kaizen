/**
 * The closed vocabularies, and the one predicate that reads them together.
 *
 * This module imports nothing — deliberately. `suggestion.mjs` already imports
 * `config.mjs`, so a min-severity check written in `config.mjs` would need
 * `SEVERITIES` back from `suggestion.mjs` and close a cycle. Pulling all four
 * vocabularies down here does not add an edge, it *removes* one: `suggestion.mjs`
 * stops importing `config.mjs` entirely. Staying import-free also keeps this file
 * safe to pull into a browser bundle later, which a module reaching for `node:fs`
 * would not be.
 */

export const TYPES = ['determinism', 'structural', 'behavioral', 'content', 'tooling', 'hygiene'];
export const OBJECTIVES = ['bug', 'guardrail', 'feature', 'performance', 'clarity', 'debt'];
export const EFFORTS = ['S', 'M', 'L'];
export const SEVERITIES = ['low', 'medium', 'high'];

/**
 * What the user asked to see. Stored expanded rather than as a deny-list so it
 * maps one-to-one onto a checkbox group; the cost is that a seventh change type
 * added later would be invisible to anyone with a saved config until they re-save.
 * Recoverable, and the taxonomy has not moved in the life of this project.
 */
export function defaultSurface() {
  return { types: [...TYPES], objectives: [...OBJECTIVES], minSeverity: 'low' };
}

/**
 * Read the block out of a config that may not have it.
 *
 * `POST /api/config` stores what it is given verbatim, so a save from the raw
 * JSON editor can legitimately leave `surface` undefined on a running server.
 * Falling back per-field rather than wholesale means a config carrying only
 * `minSeverity` keeps the default vocabularies.
 */
export function surfaceOf(config) {
  const d = defaultSurface();
  const s = config?.surface ?? {};
  return {
    types: Array.isArray(s.types) ? s.types : d.types,
    objectives: Array.isArray(s.objectives) ? s.objectives : d.objectives,
    minSeverity: SEVERITIES.includes(s.minSeverity) ? s.minSeverity : d.minSeverity,
  };
}

/** Does the user want this one in front of them? */
export function passesSurface(s, surface) {
  // An untriaged suggestion has no type, no objective and no severity, so every
  // allow-list below would reject it — which would hide exactly the work that
  // needs triage and pin the untriaged count at zero forever. Nothing can be
  // filtered on labels it does not have yet.
  if (!s.triaged) return true;

  if (!surface.types.includes(s.type)) return false;
  if (!surface.objectives.includes(s.objective)) return false;
  return SEVERITIES.indexOf(s.severity) >= SEVERITIES.indexOf(surface.minSeverity);
}

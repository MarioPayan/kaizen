/** The engine's public surface. Everything else in this package is internal. */
export {
  loadConfig,
  saveConfig,
  defaultConfig,
  validateConfig,
  withDefaults,
  resolveTargets,
  expandPath,
  configPath,
  TYPES,
  OBJECTIVES,
  EFFORTS,
} from './config.mjs';
export { buildState, discoverSkills, discoverProjectSkills, discoverSuggestions } from './scan.mjs';
export {
  parseSuggestion,
  parseFrontmatter,
  writeFrontmatter,
  score,
  splitFilename,
  STATUSES,
} from './suggestion.mjs';
export { SEVERITIES, defaultSurface, surfaceOf, passesSurface } from './taxonomy.mjs';
export { runDoctor, findingToMarkdown, CHECKS } from './doctor.mjs';
export {
  loadLifecycle,
  validateLifecycle,
  renderMarkdown,
  LIFECYCLE_PATH,
  spec,
  statusIds,
  canonicalStatus,
  isTerminal,
  canTransition,
  nextStatuses,
  awaitingDecision,
  entryStatus,
  section,
  requirementsFor,
  missingRequirements,
  patchWindow,
  inPatchWindow,
  hasLanded,
} from './lifecycle.mjs';
export { categorize } from './categories.mjs';
export { readAsks, passDue, parseCadence, lastSlot, windowDays, historyPath, stampPath } from './asks.mjs';
export { assertInside, isInside, parseSuggestionId, suggestionId } from './paths.mjs';

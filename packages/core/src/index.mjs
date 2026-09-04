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
export {
  buildState,
  assignBlockedBy,
  discoverSkills,
  discoverProjectSkills,
  discoverSuggestions,
  normalizeScope,
} from './scan.mjs';
export {
  parseSuggestion,
  parseFrontmatter,
  writeFrontmatter,
  score,
  splitFilename,
  assignUids,
  ageOf,
  localToday,
  patchIdentity,
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
  awaitsPass,
  pendingPass,
  nextPhase,
  runnerOf,
  entryStatus,
  section,
  writeSection,
  requirementsFor,
  missingRequirements,
  patchWindow,
  inPatchWindow,
  hasLanded,
  statusLine,
  pileGlyph,
} from './lifecycle.mjs';
export { readAsks, passDue, parseCadence, lastSlot, windowDays, historyPath, stampPath } from './asks.mjs';
export { assertInside, isInside, parseSuggestionId, suggestionId } from './paths.mjs';

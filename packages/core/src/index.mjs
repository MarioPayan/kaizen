/** The engine's public surface. Everything else in this package is internal. */
export {
  loadConfig,
  saveConfig,
  defaultConfig,
  validateConfig,
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
  SEVERITIES,
} from './suggestion.mjs';
export { clusterSuggestions, DEFAULT_THRESHOLD } from './cluster.mjs';
export { assertInside, isInside, parseSuggestionId, suggestionId } from './paths.mjs';

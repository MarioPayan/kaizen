export {
  CONFIG_VERSION,
  configPath,
  defaultConfig,
  defaultSources,
  expandPath,
  loadConfig,
  resolveSources,
  resolveTargets,
  saveConfig,
  validateConfig,
  withDefaults,
} from './config.mjs';
export {
  applyScopeAlias,
  bareScope,
  buildState,
  discoverProjectSkills,
  discoverSkills,
  discoverSuggestions,
  normalizeScope,
  repoRoot,
  scopeKey,
  scopePath,
  targetFor,
} from './scan.mjs';
export {
  STATUSES,
  SEVERITIES,
  appendSection,
  canonicalStatus,
  isOpen,
  parseFrontmatter,
  parseSuggestion,
  section,
  splitFilename,
  writeFrontmatter,
} from './suggestion.mjs';
export { CHECKS, runDoctor } from './doctor.mjs';
export { fixDate, recurredAfterFix } from './recurrence.mjs';
export { assertInside, isInside, parseSuggestionId, suggestionId } from './paths.mjs';
export { contentWords, findDuplicate } from './dedupe.mjs';
export { proposeAliases, renameMap } from './aliases.mjs';
export { lintMemory, projectCwd, references } from './memory.mjs';
export { originBullets, originSlug, retirementCandidates } from './retirement.mjs';

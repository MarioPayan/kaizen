/**
 * The data layer: what a suggestion is, how to fetch it, and the rules that hold
 * regardless of how it is drawn. Imports nothing from the UI, by design — a view
 * can be replaced without touching any of this.
 */
export type {
  Suggestion,
  Cluster,
  Skill,
  State,
  Metrics,
  Target,
  Config,
  Status,
  Severity,
  ChangeType,
  Objective,
} from './types';

export {
  useKaizenState,
  useConfig,
  useSkillFile,
  useDiff,
  useSetStatus,
  useSetClusterStatus,
  useApply,
  useSaveConfig,
} from './client';

export {
  RUNGS,
  isOpen,
  isApplyable,
  rankSuggestions,
  clusterMembers,
  actionableClusters,
  skillHealth,
  conversionCandidates,
  incidentsByRung,
  collapsedWorktrees,
  describeRung,
} from './domain';
export type { SkillHealth } from './domain';

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
  useLiveUpdates,
  useConfig,
  useSkillFile,
  useDiff,
  useSetStatus,
  useSetClusterStatus,
  useApply,
  useSaveConfig,
} from './client';

/**
 * The lifecycle spec, generated from `lifecycle.json`. Everything the app knows
 * about phases, statuses and the item format comes through here — there is no
 * second list to keep in step.
 */
export { LIFECYCLE } from './lifecycle.generated';
export type { Phase, LifecycleStatus, LifecycleField, StatusTone } from './lifecycle.generated';

export {
  RUNGS,
  isOpen,
  canTransition,
  nextStatuses,
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

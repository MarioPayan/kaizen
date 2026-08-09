/** Mirrors what `scripts/lib/scan.mjs` emits. The scanner is the single source. */

export type Severity = 'low' | 'medium' | 'high' | '';

/**
 * Generated from `lifecycle.json`, not written here.
 *
 * The scanner canonicalises on read, so a `new` on disk arrives as `recorded`
 * and this union only ever needs the canonical ids. Adding a status to the spec
 * makes every exhaustive switch in the app fail to compile until it is handled,
 * which is the point of generating it rather than importing the JSON directly.
 */
import type { LifecycleStatus } from './lifecycle.generated';
export type Status = LifecycleStatus;
export type ChangeType = 'determinism' | 'structural' | 'behavioral' | 'content' | 'tooling' | 'hygiene' | '';
export type Objective = 'bug' | 'guardrail' | 'feature' | 'performance' | 'clarity' | 'debt' | '';

export interface Suggestion {
  id: string;
  file: string;
  target: string;
  skill: string;
  date: string;
  slug: string;
  severity: Severity;
  status: Status;
  type: ChangeType;
  objective: Objective;
  scope: string;
  rung: number | null;
  effort: 'S' | 'M' | 'L' | '';
  clusterPin: string;
  appliedSha: string;
  recurrences: number;
  incidents: number;
  context: string;
  suggestion: string;
  rationale: string;
  missing: string[];
  triaged: boolean;
  /** Did this pass the user's `surface` preference? Untriaged always does. */
  surfaced: boolean;
  score: number;
}

export interface Cluster {
  id: string;
  pinned: boolean;
  members: string[];
  size: number;
  incidents: number;
  score: number;
  skills: string[];
  scopes: string[];
  first: string;
  last: string;
  spanDays: number;
  promoted: boolean;
}

export interface Skill {
  name: string;
  kind: 'user' | 'library' | 'project';
  target: string;
  path: string;
  dir?: string;
  project?: string;
  foundIn?: string;
  /** Worktrees of this repo collapsed into this entry. */
  worktrees?: number;
  lines: number;
  scripts: number;
  suggestions: number;
  per100: number;
}

export interface Metrics {
  total: number;
  open: number;
  untriaged: number;
  incidents: number;
  recurrences: number;
  clusters: number;
  promotedClusters: number;
  incidentsByRung: Record<string, number>;
  proseLines: number;
  scriptCount: number;
  incidentsPer100Lines: number;
}

export interface Target {
  name: string;
  skills: string;
  feedback: string;
  writable: boolean;
}

export interface State {
  generatedAt: string;
  targets: Target[];
  warnings: string[];
  skills: Skill[];
  suggestions: Suggestion[];
  clusters: Cluster[];
  orphans: string[];
  metrics: Metrics;
}

export interface Config {
  version: number;
  targets: Target[];
  scan: { enabled: boolean; roots: string[]; depth: number; writable: boolean };
  cadence: { weekly: string; sessionHook: boolean };
  surface: {
    types: Exclude<ChangeType, ''>[];
    objectives: Exclude<Objective, ''>[];
    minSeverity: Exclude<Severity, ''>;
  };
  models: { triage: string; proposal: string; validate: string };
  autoApply: string[];
  clusterPromotion: { members: number; incidents: number };
  applyGuards: { requireCleanTree: boolean; requireDiffApplies: boolean };
  server: { host: string; port: number };
}

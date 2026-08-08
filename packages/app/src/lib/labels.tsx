import type { ChangeType, Objective, Severity, Status } from '@kaizen/data';
import type { Tone } from '@kaizen/ui';

/**
 * Where domain values meet presentation.
 *
 * This mapping lives in the app rather than in either package it joins: the data
 * layer should not know what colour a bug is, and the UI should not know what a
 * bug is at all. Composition is the app's job, and this is the whole of it.
 */

const TYPE_TONE: Record<ChangeType, Tone> = {
  determinism: 'accent',
  structural: 'neutral',
  behavioral: 'neutral',
  content: 'neutral',
  tooling: 'neutral',
  hygiene: 'neutral',
  '': 'neutral',
};

const OBJECTIVE_TONE: Record<Objective, Tone> = {
  bug: 'rust',
  guardrail: 'brass',
  performance: 'accent',
  feature: 'neutral',
  clarity: 'neutral',
  debt: 'neutral',
  '': 'neutral',
};

const STATUS_TONE: Record<Status, Tone> = {
  new: 'neutral',
  proposed: 'brass',
  approved: 'accent',
  applied: 'accent',
  rejected: 'neutral',
  superseded: 'neutral',
};

export const typeTone = (t: ChangeType): Tone => TYPE_TONE[t] ?? 'neutral';
export const objectiveTone = (o: Objective): Tone => OBJECTIVE_TONE[o] ?? 'neutral';
export const statusTone = (s: Status): Tone => STATUS_TONE[s] ?? 'neutral';

export const severityTone = (s: Severity): Tone | 'blank' =>
  s === 'high' ? 'rust' : s === 'medium' ? 'brass' : s === 'low' ? 'neutral' : 'blank';

/** Explanations shown on hover. Written for someone who did not design the taxonomy. */
export const TYPE_HELP: Record<string, string> = {
  determinism: 'Moves a step down the ladder — prose becomes a script or a hook.',
  structural: 'Changes layout, module boundaries, or the contract between skills.',
  behavioral: 'Changes what a skill decides or does.',
  content: 'Wording, examples, clarity. No behaviour change.',
  tooling: 'The machinery around the skills — scripts, hooks, this app.',
  hygiene: 'Dedupe, dead skills, stale paths, naming.',
};

export const OBJECTIVE_HELP: Record<string, string> = {
  bug: 'Something produced a wrong or failed result.',
  guardrail: 'Prevents a recurring class of failure, not just this instance.',
  feature: 'New capability.',
  performance: 'Faster, fewer tokens, fewer turns.',
  clarity: 'Less ambiguity for whoever reads the skill next.',
  debt: 'Cleanup with no user-visible effect.',
};

export const SCORE_HELP = 'impact x (1 + recurrences) / effort. Untriaged items score zero.';

/**
 * Domain rules that are not presentation.
 *
 * These live here rather than in a view because they are the same facts however
 * they are drawn — a cluster's health, whether a suggestion can be applied, what
 * a rung means. A second view must not be able to disagree with the first.
 */
import type { Cluster, Skill, State, Suggestion } from './types';

export const RUNGS = [
  {
    n: 0,
    title: 'Harness enforces it',
    detail: 'A hook, a permission rule, a CLAUDE.md line. Cannot drift, cannot be skipped.',
    cost: '0 tokens',
  },
  {
    n: 1,
    title: 'A script decides',
    detail: 'Shell returning a verdict. Testable, greppable, identical every run.',
    cost: 'one Bash call',
  },
  {
    n: 2,
    title: 'A written rule',
    detail: 'Prose re-read and re-interpreted every run. Fine when the input genuinely varies.',
    cost: 'tokens every run',
  },
  {
    n: 3,
    title: 'Left to reasoning',
    detail: 'Nothing written down. Where most recorded failures came from.',
    cost: 'tokens + drift',
  },
] as const;

/** Terminal statuses: the item is out of the queue for good. */
const CLOSED = new Set(['applied', 'rejected', 'superseded']);

export const isOpen = (s: Suggestion) => !CLOSED.has(s.status);

/**
 * A suggestion is ready to apply only when someone approved it *and* a real
 * patch exists. Approval alone is a record of intent, not an instruction.
 */
export const isApplyable = (s: Suggestion, hasPatch: boolean) => s.status === 'approved' && hasPatch;

export function rankSuggestions(list: Suggestion[]): Suggestion[] {
  return [...list].sort((a, b) => b.score - a.score || b.incidents - a.incidents);
}

export function clusterMembers(state: State, cluster: Cluster): Suggestion[] {
  const ids = new Set(cluster.members);
  return rankSuggestions(state.suggestions.filter((s) => ids.has(s.id)));
}

/** Clusters worth acting on: more than one member, ranked by what they cost. */
export function actionableClusters(state: State): Cluster[] {
  return state.clusters
    .filter((c) => c.size > 1)
    .sort((a, b) => Number(b.promoted) - Number(a.promoted) || b.incidents - a.incidents);
}

export type SkillHealth = 'scripted' | 'noisy' | 'watch' | 'quiet';

/**
 * The thesis, as a label. A skill with scripts and no complaints is the shape
 * the system is trying to produce; heavy prose with a high complaint rate is
 * what it is trying to remove.
 */
export function skillHealth(skill: Skill): SkillHealth {
  if (skill.scripts > 0 && skill.suggestions === 0) return 'scripted';
  if (skill.per100 >= 2) return 'noisy';
  if (skill.per100 > 0) return 'watch';
  return 'quiet';
}

/** Incidents whose fix belongs in a script, by cluster — the conversion backlog. */
export function conversionCandidates(state: State, limit = 8) {
  return state.clusters
    .map((cluster) => {
      const scriptable = clusterMembers(state, cluster).filter((s) => s.rung !== null && s.rung <= 1);
      return {
        id: cluster.id,
        label: cluster.scopes[0] ?? cluster.id,
        incidents: scriptable.reduce((sum, s) => sum + s.incidents, 0),
      };
    })
    .filter((c) => c.incidents > 0)
    .sort((a, b) => b.incidents - a.incidents)
    .slice(0, limit);
}

export function incidentsByRung(state: State): number[] {
  return [0, 1, 2, 3].map((n) => state.metrics.incidentsByRung[String(n)] ?? 0);
}

/** How many worktrees were folded away, so the collapse is visible not silent. */
export function collapsedWorktrees(state: State): number {
  const perRepo = new Map<string, number>();
  for (const skill of state.skills) {
    if (skill.worktrees && skill.project) perRepo.set(skill.project, skill.worktrees);
  }
  return [...perRepo.values()].reduce((a, b) => a + b, 0);
}

export const describeRung = (rung: number | null) =>
  rung === null ? 'untriaged' : (RUNGS[rung]?.title ?? `rung ${rung}`);

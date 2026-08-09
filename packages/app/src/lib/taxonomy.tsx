import {
  LIFECYCLE,
  RUNGS,
  type ChangeType,
  type Objective,
  type Severity,
  type StatusTone,
} from '@kaizen/data';
import { Chip, Help, type Tone } from '@kaizen/ui';

/**
 * Where domain values meet presentation, and the one place either is explained.
 *
 * This mapping lives in the app rather than in either package it joins: the data
 * layer should not know what colour a bug is, and the UI should not know what a
 * bug is at all. Composition is the app's job, and this is the whole of it.
 *
 * Every sentence here is rendered in two places — the Docs page and the popover
 * on the chip itself. That is deliberate: documentation nobody can reach from the
 * thing it describes does not get read, and a second copy of the wording would
 * drift within a month.
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

/**
 * The spec's tone is semantic, not a colour — it has five values because a
 * terminal has green and red to spend. This palette has four, so `positive`
 * lands on the accent alongside `accent`. Collapsing here rather than in the
 * spec is what lets the TUI keep the distinction.
 */
const TONE_FOR: Record<StatusTone, Tone> = {
  accent: 'accent',
  positive: 'accent',
  warning: 'brass',
  negative: 'rust',
  muted: 'neutral',
};

/** Keyed by status id and by every alias, so an older file still gets a colour. */
const STATUS_TONE: Record<string, Tone> = Object.fromEntries(
  LIFECYCLE.statuses.flatMap((s) => {
    const tone = TONE_FOR[s.tone];
    return [[s.id, tone], ...s.aliases.map((a) => [a, tone] as const)];
  }),
);

export const typeTone = (t: ChangeType): Tone => TYPE_TONE[t] ?? 'neutral';
export const objectiveTone = (o: Objective): Tone => OBJECTIVE_TONE[o] ?? 'neutral';
/** Takes a plain string: a row carries the legacy vocabulary, the spec carries the new one. */
export const statusTone = (s: string): Tone => STATUS_TONE[s] ?? 'neutral';

export const severityTone = (s: Severity): Tone | 'blank' =>
  s === 'high' ? 'rust' : s === 'medium' ? 'brass' : s === 'low' ? 'neutral' : 'blank';

/** `blank` is a dot state, not a text colour — a word has to be *some* colour. */
export const asChipTone = (t: Tone | 'blank'): Tone => (t === 'blank' ? 'neutral' : t);

/* ------------------------------------------------------------- the prose -- */

/** Explanations written for someone who did not design the taxonomy. */
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

export const SEVERITY_HELP: Record<string, string> = {
  high: 'Something broke — an error, a wrong result, or you had to step in.',
  medium: 'Slowed the run down, or forced a workaround.',
  low: 'Polish. Nothing actually failed.',
};

export const EFFORT_HELP: Record<string, string> = {
  S: 'One file, one edit. Minutes, and trivially reverted.',
  M: 'A few files, or a new script. Something to verify before it lands.',
  L: 'Changes how the pieces fit together. Worth planning before starting.',
};

/**
 * Keyed by status id *and* by every alias. A queue row carries whatever its file
 * says, which for anything written before the lifecycle spec is `new` or
 * `proposed` — and a chip whose popover says nothing is worse than one whose
 * popover says the right thing under an older name.
 */
export const STATUS_HELP: Record<string, string> = Object.fromEntries(
  LIFECYCLE.statuses.flatMap((s) => [[s.id, s.help] as const, ...s.aliases.map((a) => [a, s.help] as const)]),
);

export const RUNG_HELP: Record<string, string> = Object.fromEntries(
  RUNGS.map((r) => [String(r.n), `${r.title}. ${r.detail} Costs ${r.cost}.`]),
);

export const SCORE_HELP = 'impact x (1 + recurrences) / effort. Untriaged items score zero.';

export const SURFACE_HELP =
  'Hidden by what you asked to see in Settings. Nothing was deleted — the file is still on disk and still counted.';

/* ------------------------------------------------------------- the chips -- */

/** A chip that explains itself. Same sentence the Docs page shows. */
export function Explain({
  help,
  tone = 'neutral',
  children,
}: {
  help?: string;
  tone?: Tone;
  children: React.ReactNode;
}) {
  if (!help) return <Chip tone={tone}>{children}</Chip>;
  return (
    <Help content={help}>
      <Chip tone={tone}>{children}</Chip>
    </Help>
  );
}

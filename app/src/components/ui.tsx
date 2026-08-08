import type { ReactNode } from 'react';
import type { ChangeType, Objective, Severity, Status } from '../types';

/* State is encoded in form as well as in words, so what needs attention reads at
   a glance rather than requiring the label to be parsed. */

const TONE = {
  neutral: 'border-line bg-surface-2 text-ink-2',
  accent: 'border-accent bg-accent-soft text-accent-ink',
  brass: 'border-brass bg-brass-soft text-brass',
  rust: 'border-rust bg-rust-soft text-rust',
} as const;

export type Tone = keyof typeof TONE;

export function Chip({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-block border px-1.5 py-px font-mono text-[0.65rem] tracking-wide whitespace-nowrap ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

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
  feature: 'neutral',
  performance: 'accent',
  clarity: 'neutral',
  debt: 'neutral',
  '': 'neutral',
};

export const typeTone = (t: ChangeType) => TYPE_TONE[t] ?? 'neutral';
export const objectiveTone = (o: Objective) => OBJECTIVE_TONE[o] ?? 'neutral';

export function SeverityMark({ severity }: { severity: Severity }) {
  const color = severity === 'high' ? 'bg-rust' : severity === 'medium' ? 'bg-brass' : 'bg-ink-3';
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[0.7rem] whitespace-nowrap text-ink-2">
      <span className={`h-3 w-[3px] ${severity ? color : 'bg-line'}`} />
      {severity || 'unrated'}
    </span>
  );
}

const STATUS_TONE: Record<Status, Tone> = {
  new: 'neutral',
  proposed: 'brass',
  approved: 'accent',
  applied: 'accent',
  rejected: 'neutral',
  superseded: 'neutral',
};

export function StatusChip({ status }: { status: Status }) {
  return <Chip tone={STATUS_TONE[status]}>{status}</Chip>;
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`border border-line bg-surface p-4 ${className}`}>{children}</div>;
}

export function Button({
  children,
  onClick,
  tone = 'accent',
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'accent' | 'ghost';
  disabled?: boolean;
  title?: string;
}) {
  const base =
    tone === 'accent'
      ? 'border-accent bg-accent-soft text-accent-ink hover:brightness-105'
      : 'border-line bg-surface text-ink-2 hover:text-ink';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`border px-2.5 py-1 font-mono text-[0.7rem] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${base}`}
    >
      {children}
    </button>
  );
}

export function Stat({
  value,
  label,
  tone = 'neutral',
}: {
  value: ReactNode;
  label: string;
  tone?: 'neutral' | 'rust' | 'brass' | 'accent';
}) {
  const color =
    tone === 'rust'
      ? 'text-rust'
      : tone === 'brass'
        ? 'text-brass'
        : tone === 'accent'
          ? 'text-accent'
          : 'text-ink';
  return (
    <div className="bg-surface px-4 py-3">
      <span className={`block font-mono text-2xl leading-none font-bold tabular-nums ${color}`}>{value}</span>
      <span className="mt-1.5 block text-xs leading-snug text-ink-2">{label}</span>
    </div>
  );
}

export function Bar({
  label,
  value,
  max,
  tone = 'accent',
}: {
  label: string;
  value: number;
  max: number;
  tone?: 'accent' | 'brass' | 'rust';
}) {
  const fill = tone === 'brass' ? 'bg-brass' : tone === 'rust' ? 'bg-rust' : 'bg-accent';
  return (
    <div className="grid grid-cols-[minmax(0,11rem)_1fr_2.5rem] items-center gap-3 text-sm">
      <span className="truncate font-mono text-xs">{label}</span>
      <span className="h-3.5 border border-line-soft bg-sunk">
        <span
          className={`block h-full ${fill} opacity-85`}
          style={{ width: `${max > 0 ? (value / max) * 100 : 0}%` }}
        />
      </span>
      <span className="text-right font-mono text-xs tabular-nums text-ink-2">{value}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-1 py-8 text-center text-sm text-ink-3">{children}</p>;
}

export function ErrorNote({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <p className="border-l-2 border-rust bg-rust-soft px-3 py-2 font-mono text-xs text-rust">
      {error.message}
    </p>
  );
}

import type { ReactNode } from 'react';

/**
 * The flat pieces: no state, no Base UI, no domain knowledge.
 *
 * Tone is deliberately a small closed set. Semantic colour (good / attention /
 * damage) stays separate from the accent so "needs attention" never reads as
 * "this is just the brand colour".
 */

export const TONES = {
  neutral: 'border-line bg-surface-2 text-ink-2',
  accent: 'border-accent bg-accent-soft text-accent-ink',
  brass: 'border-brass bg-brass-soft text-brass',
  rust: 'border-rust bg-rust-soft text-rust',
} as const;

export type Tone = keyof typeof TONES;

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
      className={`inline-flex items-center border px-1.5 py-px font-mono text-[0.65rem] tracking-wide whitespace-nowrap ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** A short bar of colour reads faster than a word at the end of a dense row. */
export function Gauge({ tone, label }: { tone: Tone | 'blank'; label: string }) {
  const fill =
    tone === 'rust'
      ? 'bg-rust'
      : tone === 'brass'
        ? 'bg-brass'
        : tone === 'accent'
          ? 'bg-accent'
          : tone === 'neutral'
            ? 'bg-ink-3'
            : 'bg-line';
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[0.7rem] whitespace-nowrap text-ink-2">
      <span className={`h-3 w-[3px] ${fill}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function Panel({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'li';
}) {
  return <Tag className={`border border-line bg-surface p-4 ${className}`}>{children}</Tag>;
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  title,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
}) {
  const look =
    variant === 'primary'
      ? 'border-accent bg-accent-soft text-accent-ink hover:brightness-105'
      : variant === 'danger'
        ? 'border-rust bg-rust-soft text-rust hover:brightness-105'
        : 'border-line bg-surface text-ink-2 hover:text-ink hover:bg-surface-2';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`border px-2.5 py-1 font-mono text-[0.7rem] font-semibold transition-[filter,color,background-color] disabled:cursor-not-allowed disabled:opacity-40 ${look}`}
    >
      {children}
    </button>
  );
}

export function Stat({
  value,
  label,
  tone = 'neutral',
  hint,
}: {
  value: ReactNode;
  label: string;
  tone?: 'neutral' | 'rust' | 'brass' | 'accent';
  hint?: string;
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
    <div className="bg-surface px-4 py-3" title={hint}>
      <span className={`block font-mono text-2xl leading-none font-bold tabular-nums ${color}`}>{value}</span>
      <span className="mt-1.5 block text-xs leading-snug text-ink-2">{label}</span>
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[0.62rem] tracking-[0.16em] uppercase text-ink-3">{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-1 py-10 text-center text-sm text-ink-3">{children}</p>;
}

/**
 * Errors quote the server verbatim. Its refusals are specific — a read-only
 * target, a dirty tree — and replacing them with something generic would throw
 * away the only part of the message that tells you what to do next.
 */
export function ErrorNote({ error }: { error: Error | null | undefined }) {
  if (!error) return null;
  return (
    <p role="alert" className="border-l-2 border-rust bg-rust-soft px-3 py-2 font-mono text-xs text-rust">
      {error.message}
    </p>
  );
}

export function Note({ children, tone = 'brass' }: { children: ReactNode; tone?: Tone }) {
  const look =
    tone === 'rust'
      ? 'border-rust bg-rust-soft text-rust'
      : tone === 'accent'
        ? 'border-accent bg-accent-soft text-accent-ink'
        : 'border-brass bg-brass-soft text-brass';
  return <p className={`border-l-2 px-3 py-2 text-xs ${look}`}>{children}</p>;
}

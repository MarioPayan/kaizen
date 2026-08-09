import { Button as BaseButton } from '@base-ui/react/button';
import type { ReactNode } from 'react';

/**
 * The flat pieces: no state, no domain knowledge.
 *
 * Tone is a small closed set, and in this design it is spent sparingly: most
 * rows carry no colour at all. Semantic colour (attention / damage) stays
 * separate from the accent so "needs attention" never reads as "brand colour".
 */
export const TONES = {
  neutral: 'text-ink-3',
  accent: 'text-accent',
  brass: 'text-brass',
  rust: 'text-rust',
} as const;

export type Tone = keyof typeof TONES;

const FILL: Record<Tone | 'blank', string> = {
  neutral: 'bg-ink-3',
  accent: 'bg-accent',
  brass: 'bg-brass',
  rust: 'bg-rust',
  blank: 'bg-line',
};

/**
 * A label with no box around it.
 *
 * The previous version bordered and filled every chip, which meant a row of five
 * of them out-shouted the sentence they described. Here the word carries its own
 * colour and nothing else does — at five per row that is the difference between
 * a row you can read and a row you have to parse.
 */
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
      className={`inline-flex items-center font-mono text-micro whitespace-nowrap ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * One dot, at the head of a row, carrying the single most urgent fact about it.
 *
 * Everything a row could say — severity, recurrence, status, rung — used to be
 * said at once and at equal volume. A dot says the one thing worth knowing
 * before you decide whether to read further; the rest waits until you do.
 */
export function Dot({ tone, label }: { tone: Tone | 'blank'; label: string }) {
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      className={`inline-block size-1.5 shrink-0 rounded-full ${FILL[tone]}`}
    />
  );
}

/** A key the user can actually press. Rendered, not described. */
export function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border border-line px-1 py-px font-mono text-micro text-ink-3">{children}</kbd>
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
  return <Tag className={`bg-surface p-4 ${className}`}>{children}</Tag>;
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
      ? 'border-transparent bg-accent text-ground hover:brightness-110'
      : variant === 'danger'
        ? 'border-line text-rust hover:bg-rust-soft'
        : 'border-line text-ink-2 hover:text-ink hover:bg-surface-2';
  return (
    <BaseButton
      type={type}
      onClick={onClick}
      disabled={disabled}
      // Apply spends most of its life disabled and the reason lives in `title`.
      // A natively disabled button is out of the tab order, so that explanation
      // is unreachable by keyboard; this keeps it focusable and inert.
      focusableWhenDisabled
      title={title}
      className={`rounded-sm border px-2.5 py-1 text-meta font-medium transition-[filter,color,background-color] data-disabled:cursor-not-allowed data-disabled:opacity-40 ${look}`}
    >
      {children}
    </BaseButton>
  );
}

/** Live or not. Two states, one glyph — anything more is a status page. */
export function Live({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      title={label}
      aria-label={label}
      className={`inline-block size-1.5 rounded-full ${on ? 'bg-accent' : 'border border-ink-3'}`}
    />
  );
}

export function Stat({
  value,
  label,
  tone = 'neutral',
  hint,
  onClick,
}: {
  value: ReactNode;
  label: string;
  tone?: 'neutral' | 'rust' | 'brass' | 'accent';
  hint?: string;
  /** A number worth acting on becomes the way to act on it. */
  onClick?: () => void;
}) {
  const color =
    tone === 'rust'
      ? 'text-rust'
      : tone === 'brass'
        ? 'text-brass'
        : tone === 'accent'
          ? 'text-accent'
          : 'text-ink';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`px-0 py-0 pr-6 text-left ${onClick ? 'cursor-pointer hover:opacity-80' : ''}`}
      title={hint}
    >
      <span className={`block text-display leading-none font-semibold tracking-tight tabular-nums ${color}`}>
        {value}
      </span>
      <span className="mt-1 block text-micro leading-snug text-ink-3">{label}</span>
    </Tag>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[0.62rem] tracking-[0.16em] uppercase text-ink-3">{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-1 py-12 text-center text-meta text-ink-3">{children}</p>;
}

/**
 * Errors quote the server verbatim. Its refusals are specific — a read-only
 * target, a dirty tree — and replacing them with something generic would throw
 * away the only part of the message that tells you what to do next.
 */
export function ErrorNote({ error }: { error: Error | null | undefined }) {
  if (!error) return null;
  return (
    <p role="alert" className="border-l-2 border-rust bg-rust-soft px-3 py-2 font-mono text-meta text-rust">
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
  return <p className={`border-l-2 px-3 py-2 text-meta ${look}`}>{children}</p>;
}

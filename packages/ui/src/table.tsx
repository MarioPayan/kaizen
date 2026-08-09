import type { ReactNode } from 'react';

/**
 * Table pieces rather than a table component. Every view here needs different
 * cells, and a configurable table would end up longer than the tables it saves.
 */

export function Table({ children, className = '' }: { children: ReactNode; className?: string }) {
  // Wide content scrolls inside its own container so the page never moves sideways.
  return (
    <div className={`overflow-x-auto border border-line bg-surface ${className}`}>
      <table className="w-full border-collapse text-left text-[0.83rem]">{children}</table>
    </div>
  );
}

export function Th({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`border-b border-line bg-surface-2 px-3 py-2 font-mono text-[0.62rem] tracking-[0.09em] whitespace-nowrap uppercase text-ink-3 ${align === 'right' ? 'text-right' : ''}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  numeric,
  className = '',
}: {
  children: ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`border-b border-line-soft px-3 py-2 align-top ${numeric ? 'text-right font-mono tabular-nums whitespace-nowrap' : ''} ${className}`}
    >
      {children}
    </td>
  );
}

export function Tr({
  children,
  selectable,
  selected,
}: {
  children: ReactNode;
  selectable?: boolean;
  selected?: boolean;
}) {
  return (
    <tr
      className={`last:[&>td]:border-b-0 ${selectable ? 'cursor-pointer' : ''} ${selected ? 'bg-surface-2' : 'hover:bg-surface-2'}`}
    >
      {children}
    </tr>
  );
}

/**
 * The clickable part of a selectable row.
 *
 * A handler on the `<tr>` itself works with a mouse and is unreachable by
 * keyboard — the row is not focusable and never will be. A real button filling
 * the cell is the whole fix.
 */
export function RowTrigger({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-3 -my-2 block w-[calc(100%+1.5rem)] cursor-pointer px-3 py-2 text-left focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}

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
  onClick,
  selected,
}: {
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
}) {
  return (
    <tr
      onClick={onClick}
      className={`last:[&>td]:border-b-0 ${onClick ? 'cursor-pointer' : ''} ${selected ? 'bg-surface-2' : 'hover:bg-surface-2'}`}
    >
      {children}
    </tr>
  );
}

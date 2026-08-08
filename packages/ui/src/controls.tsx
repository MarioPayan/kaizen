import { Select as BaseSelect } from '@base-ui/react/select';
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { Collapsible } from '@base-ui/react/collapsible';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { Meter as BaseMeter } from '@base-ui/react/meter';
import type { ReactNode } from 'react';

/**
 * Interactive components, wrapped once so the application never touches Base UI
 * directly. Base UI supplies the behaviour worth not rewriting — focus
 * management, keyboard handling, portalling, ARIA wiring — and everything here
 * is the styling on top.
 */

/* ------------------------------------------------------------------ tabs -- */

export function Tabs({
  value,
  onValueChange,
  items,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  items: { value: string; label: string; count?: number }[];
  children: ReactNode;
}) {
  return (
    <BaseTabs.Root value={value} onValueChange={(v) => onValueChange(String(v))}>
      <BaseTabs.List className="relative flex overflow-x-auto border-b border-line">
        {items.map((item) => (
          <BaseTabs.Tab
            key={item.value}
            value={item.value}
            className="relative px-4 py-2.5 font-mono text-[0.78rem] font-semibold whitespace-nowrap text-ink-2 transition-colors select-none hover:bg-surface-2 hover:text-ink data-[selected]:text-ink"
          >
            {item.label}
            {item.count !== undefined && (
              <span className="ml-1.5 font-normal text-ink-3 tabular-nums">{item.count}</span>
            )}
          </BaseTabs.Tab>
        ))}
        {/* Slides between tabs rather than redrawing, so the eye can follow it. */}
        <BaseTabs.Indicator className="absolute bottom-0 left-0 h-0.5 w-[var(--active-tab-width)] translate-x-[var(--active-tab-left)] bg-accent transition-all duration-200 ease-out" />
      </BaseTabs.List>
      {children}
    </BaseTabs.Root>
  );
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <BaseTabs.Panel value={value} className="pt-6 outline-none">
      {children}
    </BaseTabs.Panel>
  );
}

/* ---------------------------------------------------------------- select -- */

export function Select({
  value,
  onValueChange,
  options,
  label,
  className = '',
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
  className?: string;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <BaseSelect.Root value={value} onValueChange={(v) => onValueChange(String(v ?? ''))}>
      <BaseSelect.Trigger
        aria-label={label}
        className={`flex items-center gap-2 border border-line bg-surface px-2 py-1 font-mono text-xs text-ink hover:bg-surface-2 data-[popup-open]:border-accent ${className}`}
      >
        <BaseSelect.Value>{current?.label ?? label}</BaseSelect.Value>
        <BaseSelect.Icon className="text-ink-3">▾</BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} className="z-50">
          <BaseSelect.Popup className="max-h-72 overflow-auto border border-line bg-surface py-1 shadow-lg">
            {options.map((o) => (
              <BaseSelect.Item
                key={o.value}
                value={o.value}
                className="flex cursor-default items-center gap-2 px-3 py-1 font-mono text-xs text-ink-2 select-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink data-[selected]:text-accent-ink"
              >
                <BaseSelect.ItemIndicator className="w-2 text-accent">·</BaseSelect.ItemIndicator>
                <BaseSelect.ItemText>{o.label}</BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

/* ------------------------------------------------------------ disclosure -- */

/**
 * A row that opens in place. Base UI animates the panel height from its measured
 * size, so a long body does not make the list jump as it expands.
 */
export function Disclosure({
  summary,
  children,
  open,
  onOpenChange,
}: {
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={onOpenChange}
      className="border-b border-line-soft last:border-b-0"
    >
      <Collapsible.Trigger className="w-full cursor-pointer px-3 py-2 text-left hover:bg-surface-2">
        {summary}
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
        <div className="border-t border-line-soft bg-surface-2 px-4 py-3">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/* ---------------------------------------------------------------- dialog -- */

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-black/40 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <BaseDialog.Popup className="fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] w-[min(56rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col border border-line bg-surface shadow-2xl transition-all duration-150 data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0">
          <div className="flex items-baseline justify-between gap-4 border-b border-line px-4 py-3">
            <div>
              <BaseDialog.Title className="font-mono text-sm font-bold">{title}</BaseDialog.Title>
              {description && (
                <BaseDialog.Description className="mt-0.5 text-xs text-ink-3">
                  {description}
                </BaseDialog.Description>
              )}
            </div>
            <BaseDialog.Close className="border border-line px-2 py-0.5 font-mono text-xs text-ink-2 hover:text-ink">
              close
            </BaseDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/* --------------------------------------------------------------- tooltip -- */

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <BaseTooltip.Provider delay={400}>{children}</BaseTooltip.Provider>;
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={<span className="cursor-help border-b border-dotted border-ink-3" />}>
        {children}
      </BaseTooltip.Trigger>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={6} className="z-50">
          <BaseTooltip.Popup className="max-w-xs border border-line bg-surface px-2.5 py-1.5 text-xs text-ink-2 shadow-lg">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/* ----------------------------------------------------------------- meter -- */

/**
 * A meter, not a progress bar: these show a measurement within a known range,
 * which is what `<meter>` semantics mean and what a screen reader will announce.
 */
export function Meter({
  label,
  value,
  max,
  tone = 'accent',
  caption,
}: {
  label: string;
  value: number;
  max: number;
  tone?: 'accent' | 'brass' | 'rust';
  caption?: string;
}) {
  const fill = tone === 'brass' ? 'bg-brass' : tone === 'rust' ? 'bg-rust' : 'bg-accent';
  return (
    <BaseMeter.Root
      value={value}
      max={Math.max(max, 1)}
      className="grid grid-cols-[minmax(0,12rem)_1fr_2.75rem] items-center gap-3"
    >
      <BaseMeter.Label className="truncate font-mono text-xs text-ink-2" title={caption ?? label}>
        {label}
      </BaseMeter.Label>
      <BaseMeter.Track className="h-3.5 border border-line-soft bg-sunk">
        <BaseMeter.Indicator className={`h-full ${fill} opacity-85 transition-[width] duration-300`} />
      </BaseMeter.Track>
      <BaseMeter.Value className="text-right font-mono text-xs tabular-nums text-ink-2">
        {() => value}
      </BaseMeter.Value>
    </BaseMeter.Root>
  );
}

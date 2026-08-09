import { Select as BaseSelect } from '@base-ui/react/select';
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { Collapsible } from '@base-ui/react/collapsible';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { Accordion as BaseAccordion } from '@base-ui/react/accordion';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { NumberField as BaseNumberField } from '@base-ui/react/number-field';
import { Field as BaseField } from '@base-ui/react/field';
import { Fieldset as BaseFieldset } from '@base-ui/react/fieldset';
import { Form as BaseForm } from '@base-ui/react/form';
import { Checkbox } from '@base-ui/react/checkbox';
import { CheckboxGroup as BaseCheckboxGroup } from '@base-ui/react/checkbox-group';
import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import { Popover } from '@base-ui/react/popover';
import type { FormEvent, ReactNode } from 'react';

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

/* ------------------------------------------------------------- accordion -- */

/**
 * A list where rows open in place. Base UI gives arrow-key traversal across the
 * whole list and `hiddenUntilFound` panels, so the browser's own Ctrl-F finds
 * text inside a collapsed row — which starts to matter somewhere around row 30.
 */
export function Accordion({
  value,
  onValueChange,
  multiple = false,
  children,
  className = '',
}: {
  value: string[];
  onValueChange: (value: string[]) => void;
  multiple?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <BaseAccordion.Root
      value={value}
      onValueChange={(v) => onValueChange(v.map(String))}
      multiple={multiple}
      className={`flex flex-col ${className}`}
    >
      {children}
    </BaseAccordion.Root>
  );
}

export function AccordionItem({
  value,
  header,
  actions,
  selected,
  children,
}: {
  value: string;
  header: ReactNode;
  /** Rendered beside the trigger, never inside it — see below. */
  actions?: ReactNode;
  /** Under the keyboard cursor. Marked by a rail, not by a colour swap. */
  selected?: boolean;
  children: ReactNode;
}) {
  return (
    <BaseAccordion.Item
      value={value}
      className={`border-b border-line-soft last:border-b-0 ${
        selected ? 'bg-selected shadow-[inset_2px_0_0_var(--color-accent)]' : ''
      }`}
    >
      {/*
        `actions` is a sibling of the trigger rather than part of it. A button
        nested in a trigger is a button inside a button: invalid markup, and the
        trigger swallows the click before the inner one ever sees it.
        Header renders as a div, not its default h3 — sixty headings in a row is
        a garbage document outline.
      */}
      <div className="flex items-stretch gap-2">
        <BaseAccordion.Header render={<div className="min-w-0 flex-1" />}>
          <BaseAccordion.Trigger className="w-full cursor-pointer px-3 py-1 text-left hover:bg-surface-2">
            {header}
          </BaseAccordion.Trigger>
        </BaseAccordion.Header>
        {actions && <div className="flex shrink-0 items-center gap-1.5 pr-3">{actions}</div>}
      </div>
      <BaseAccordion.Panel
        hiddenUntilFound
        className="h-[var(--accordion-panel-height)] overflow-hidden transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0"
      >
        <div className="border-t border-line-soft bg-surface-2 px-4 py-3">{children}</div>
      </BaseAccordion.Panel>
    </BaseAccordion.Item>
  );
}

/* ------------------------------------------------------------------ form -- */

/**
 * `errors` is keyed by field name. The server already prefixes every validation
 * message with the config path it failed on, so naming a Field with that path is
 * all it takes to land the message under the control that caused it.
 */
export function Form({
  errors,
  onSubmit,
  children,
  className = '',
}: {
  errors: Record<string, string | string[]>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <BaseForm errors={errors} onSubmit={onSubmit} className={className}>
      {children}
    </BaseForm>
  );
}

export function Fieldset({ legend, hint, children }: { legend: string; hint?: string; children: ReactNode }) {
  return (
    <BaseFieldset.Root className="border border-line bg-surface p-4">
      <BaseFieldset.Legend className="font-mono text-sm font-bold">{legend}</BaseFieldset.Legend>
      {hint && <p className="mt-1 mb-2 text-xs text-ink-3">{hint}</p>}
      {children}
    </BaseFieldset.Root>
  );
}

/**
 * One row of the settings form. `name` is both the accessible wiring and the key
 * the server's error for this control arrives under — one string, not two that
 * can drift apart.
 */
export function Field({
  name,
  label,
  hint,
  children,
}: {
  name: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <BaseField.Root
      name={name}
      className="grid items-baseline gap-1 border-b border-line-soft py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-4"
    >
      <div>
        <BaseField.Label className="font-mono text-xs text-ink-2">{label}</BaseField.Label>
        {hint && (
          <BaseField.Description className="mt-0.5 block text-[0.7rem] text-ink-3">
            {hint}
          </BaseField.Description>
        )}
      </div>
      <div>
        {children}
        <BaseField.Error className="mt-1 block font-mono text-[0.7rem] text-rust" />
      </div>
    </BaseField.Root>
  );
}

const inputClass =
  'w-full max-w-sm border border-line bg-surface px-2 py-1 font-mono text-xs text-ink placeholder:text-ink-3 focus:outline-1 focus:-outline-offset-1 focus:outline-accent';

export function TextField({
  name,
  label,
  hint,
  value,
  onValueChange,
  placeholder,
}: {
  name: string;
  label: string;
  hint?: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <Field name={name} label={label} hint={hint}>
      <BaseField.Control
        value={value}
        placeholder={placeholder}
        onChange={(e) => onValueChange(e.target.value)}
        className={inputClass}
      />
    </Field>
  );
}

/** A bare control for rows that hold more than one of them. */
export function Input({
  value,
  onValueChange,
  placeholder,
  label,
  className = '',
}: {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  label: string;
  className?: string;
}) {
  return (
    <input
      aria-label={label}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onValueChange(e.target.value)}
      className={`${inputClass} ${className}`}
    />
  );
}

/* ---------------------------------------------------------------- switch -- */

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="flex h-4 w-8 shrink-0 border border-line bg-sunk p-px transition-colors data-checked:border-accent data-checked:bg-accent-soft data-disabled:opacity-40"
    >
      <BaseSwitch.Thumb className="size-3 bg-ink-3 transition-[translate,background-color] duration-150 data-checked:translate-x-4 data-checked:bg-accent" />
    </BaseSwitch.Root>
  );
}

/* ----------------------------------------------------------- number field -- */

/**
 * `value` is `number | null`, and null is the honest representation of an empty
 * box. The `<input type="number">` this replaces could only say `NaN`, which
 * serialised to `null` and came back from the server as a validation failure.
 */
export function NumberField({
  value,
  onValueChange,
  label,
  min,
  max,
}: {
  value: number | null;
  onValueChange: (value: number | null) => void;
  label: string;
  min?: number;
  max?: number;
}) {
  const step =
    'flex w-6 items-center justify-center border border-line bg-surface text-ink-2 select-none hover:bg-surface-2 data-disabled:opacity-40';
  return (
    <BaseNumberField.Root value={value} onValueChange={onValueChange} min={min} max={max}>
      <BaseNumberField.Group className="flex h-[1.65rem]">
        <BaseNumberField.Decrement className={`${step} border-r-0`}>−</BaseNumberField.Decrement>
        <BaseNumberField.Input
          aria-label={label}
          className="h-full w-14 border border-line bg-surface px-2 text-center font-mono text-xs text-ink tabular-nums focus:z-1 focus:outline-1 focus:-outline-offset-1 focus:outline-accent"
        />
        <BaseNumberField.Increment className={`${step} border-l-0`}>+</BaseNumberField.Increment>
      </BaseNumberField.Group>
    </BaseNumberField.Root>
  );
}

/* --------------------------------------------------------- checkbox group -- */

export function CheckboxGroup({
  value,
  onValueChange,
  options,
  label,
  allLabel,
}: {
  value: string[];
  onValueChange: (value: string[]) => void;
  options: { value: string; label: string; hint?: ReactNode }[];
  label: string;
  /** Opts into a parent checkbox that ticks and unticks the whole group. */
  allLabel?: string;
}) {
  const all = options.map((o) => o.value);
  const box = (
    <Checkbox.Indicator className="flex text-[0.6rem] leading-none data-unchecked:hidden">
      ✓
    </Checkbox.Indicator>
  );
  const boxClass =
    'flex size-3.5 shrink-0 items-center justify-center border border-line bg-surface text-accent-ink data-checked:border-accent data-checked:bg-accent-soft data-indeterminate:border-accent';

  return (
    <BaseCheckboxGroup
      value={value}
      onValueChange={onValueChange}
      allValues={all}
      aria-label={label}
      className="flex flex-wrap gap-x-4 gap-y-1.5"
    >
      {allLabel && (
        <label className="flex w-full items-center gap-2 font-mono text-[0.7rem] text-ink-3">
          <Checkbox.Root parent className={boxClass}>
            {box}
          </Checkbox.Root>
          {allLabel}
        </label>
      )}
      {options.map((o) => (
        <label
          key={o.value}
          title={typeof o.hint === 'string' ? o.hint : undefined}
          className="flex items-center gap-2 font-mono text-xs text-ink-2"
        >
          <Checkbox.Root value={o.value} className={boxClass}>
            {box}
          </Checkbox.Root>
          {o.label}
        </label>
      ))}
    </BaseCheckboxGroup>
  );
}

/* ------------------------------------------------------ segmented control -- */

/**
 * Single-select, always visible. A dropdown hides the options; these are short
 * closed sets where seeing the alternatives is half the value.
 */
export function SegmentedControl({
  value,
  onValueChange,
  options,
  label,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string; count?: number }[];
  label: string;
}) {
  return (
    <ToggleGroup
      value={[value]}
      // Base UI hands back an empty array when the pressed item is clicked again;
      // for a single-select filter that reads as "no change", not "clear".
      onValueChange={(v) => onValueChange(v.length ? String(v[v.length - 1]) : value)}
      aria-label={label}
      className="flex border border-line"
    >
      {options.map((o) => (
        <Toggle
          key={o.value}
          value={o.value}
          className="border-r border-line px-2 py-1 font-mono text-[0.7rem] text-ink-2 select-none last:border-r-0 hover:bg-surface-2 hover:text-ink data-pressed:bg-accent-soft data-pressed:text-accent-ink"
        >
          {o.label}
          {o.count !== undefined && <span className="ml-1 text-ink-3 tabular-nums">{o.count}</span>}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/* ------------------------------------------------------------------ help -- */

/**
 * "What is this?" on a chip.
 *
 * One popup for the whole page, opened by detached triggers carrying their own
 * content as the payload. A dashboard row has five chips and there can be sixty
 * rows on screen; three hundred mounted `Popover.Root`s to show one at a time is
 * the kind of thing that makes a list feel slow for no reason.
 */
const helpPopover = Popover.createHandle<ReactNode>();

export function HelpProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Popover.Root handle={helpPopover}>
        {({ payload }) => (
          <Popover.Portal>
            <Popover.Positioner sideOffset={6} className="z-50">
              <Popover.Popup className="max-w-xs border border-line bg-surface px-3 py-2 text-xs text-ink-2 shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0">
                {payload}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        )}
      </Popover.Root>
    </>
  );
}

export function Help({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <Popover.Trigger
      handle={helpPopover}
      payload={content}
      className="cursor-help focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      {children}
    </Popover.Trigger>
  );
}

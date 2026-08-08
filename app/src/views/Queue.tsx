import { useMemo, useState } from 'react';
import { useApply, useDiff, useSetStatus } from '../api';
import type { State, Suggestion } from '../types';
import {
  Button,
  Chip,
  Empty,
  ErrorNote,
  SeverityMark,
  StatusChip,
  objectiveTone,
  typeTone,
} from '../components/ui';

const FILTERS = ['type', 'objective', 'skill', 'status'] as const;
type FilterKey = (typeof FILTERS)[number];

const valueOf = (s: Suggestion, key: FilterKey) =>
  key === 'skill' ? s.skill : key === 'status' ? s.status : key === 'type' ? s.type : s.objective;

function Detail({ suggestion }: { suggestion: Suggestion }) {
  const setStatus = useSetStatus();
  const apply = useApply();
  const diff = useDiff(suggestion.id);
  const busy = setStatus.isPending || apply.isPending;

  return (
    <div className="flex flex-col gap-3 border-t border-line-soft bg-surface-2 px-4 py-3 text-sm text-ink-2">
      {suggestion.context && (
        <Field label="context">
          <p>{suggestion.context}</p>
        </Field>
      )}
      <Field label="suggestion">
        <p>{suggestion.suggestion || 'No suggestion body.'}</p>
      </Field>

      {suggestion.missing.length > 0 && (
        <Field label="needs triage">
          <p className="text-ink-3">
            missing {suggestion.missing.join(', ')} — labels are assigned by a{' '}
            <code className="font-mono">/kaizen</code> pass, not guessed here
          </p>
        </Field>
      )}

      <Field label="proposal">
        {diff.isLoading ? (
          <p className="text-ink-3">loading…</p>
        ) : diff.data?.patch ? (
          <pre className="max-h-64 overflow-auto border border-line bg-sunk p-3 font-mono text-[0.72rem] leading-relaxed">
            {diff.data.patch}
          </pre>
        ) : (
          <p className="text-ink-3">Not yet drafted. A proposal is a real patch, written by a triage pass.</p>
        )}
      </Field>

      <Field label="file">
        <code className="font-mono text-xs break-all text-ink-3">{suggestion.file}</code>
      </Field>

      <ErrorNote error={setStatus.error ?? apply.error} />

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || suggestion.status === 'approved'}
          onClick={() => setStatus.mutate({ id: suggestion.id, status: 'approved' })}
        >
          Approve
        </Button>
        <Button
          tone="ghost"
          disabled={busy || suggestion.status === 'rejected'}
          onClick={() => setStatus.mutate({ id: suggestion.id, status: 'rejected' })}
        >
          Reject
        </Button>
        <Button
          tone="ghost"
          disabled={busy || !diff.data?.patch}
          title={diff.data?.patch ? 'Apply the patch and commit' : 'No patch to apply yet'}
          onClick={() => apply.mutate({ id: suggestion.id })}
        >
          Apply
        </Button>
        {apply.data?.sha && <Chip tone="accent">applied {apply.data.sha.slice(0, 8)}</Chip>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="font-mono text-[0.62rem] tracking-widest uppercase text-ink-3">{label}</span>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export default function Queue({ state }: { state: State }) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const options = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const key of FILTERS) {
      out[key] = [...new Set(state.suggestions.map((s) => valueOf(s, key)).filter(Boolean))].sort();
    }
    return out;
  }, [state.suggestions]);

  const rows = useMemo(() => {
    const q = query.toLowerCase();
    return state.suggestions
      .filter((s) => FILTERS.every((key) => !filters[key] || valueOf(s, key) === filters[key]))
      .filter((s) => !q || `${s.slug} ${s.skill} ${s.suggestion}`.toLowerCase().includes(q))
      .sort((a, b) => b.score - a.score || b.incidents - a.incidents);
  }, [state.suggestions, filters, query]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {FILTERS.map((key) => (
          <select
            key={key}
            aria-label={key}
            value={filters[key] ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, [key]: e.target.value }))}
            className="border border-line bg-surface px-2 py-1 font-mono text-xs text-ink"
          >
            <option value="">{key}: all</option>
            {options[key]?.map((v) => (
              <option key={v} value={v}>
                {key}: {v}
              </option>
            ))}
          </select>
        ))}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search…"
          className="w-32 border border-line bg-surface px-2 py-1 font-mono text-xs text-ink"
        />
        <span className="ml-auto font-mono text-xs text-ink-3">
          {rows.length} of {state.suggestions.length}
        </span>
      </div>

      {rows.length === 0 ? (
        <Empty>Nothing matches those filters.</Empty>
      ) : (
        <div className="border border-line">
          {rows.map((s) => {
            const open = openId === s.id;
            return (
              <div key={s.id} className="border-b border-line-soft last:border-b-0">
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : s.id)}
                  aria-expanded={open}
                  className="grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 px-3 py-2 text-left hover:bg-surface-2"
                >
                  <span
                    className="text-right font-mono text-sm font-bold tabular-nums text-ink-2"
                    title="impact x incidents / effort"
                  >
                    {s.score || '—'}
                  </span>
                  <span className="truncate font-mono text-[0.8rem]">
                    <span className="text-ink-3">{s.skill} /</span> {s.slug}
                  </span>
                  <span className="flex flex-wrap justify-end gap-1">
                    {s.type && <Chip tone={typeTone(s.type)}>{s.type}</Chip>}
                    {s.objective && <Chip tone={objectiveTone(s.objective)}>{s.objective}</Chip>}
                    {s.rung !== null && <Chip>rung {s.rung}</Chip>}
                    <SeverityMark severity={s.severity} />
                    {s.recurrences > 0 && <Chip tone="rust">&times;{s.incidents}</Chip>}
                    <StatusChip status={s.status} />
                  </span>
                </button>
                {open && <Detail suggestion={s} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

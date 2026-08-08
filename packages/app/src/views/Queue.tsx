import { useMemo, useState } from 'react';
import {
  rankSuggestions,
  useApply,
  useDiff,
  useSetStatus,
  type State,
  type Status,
  type Suggestion,
} from '@kaizen/data';
import {
  Button,
  Chip,
  Dialog,
  Disclosure,
  Empty,
  ErrorNote,
  Eyebrow,
  Gauge,
  Select,
  Tooltip,
  useToast,
} from '@kaizen/ui';
import { objectiveTone, severityTone, SCORE_HELP, typeTone, statusTone } from '../lib/labels';

const FACETS = ['type', 'objective', 'skill', 'status'] as const;
type Facet = (typeof FACETS)[number];

const facetValue = (s: Suggestion, f: Facet) =>
  f === 'skill' ? s.skill : f === 'status' ? s.status : f === 'type' ? s.type : s.objective;

function Row({ suggestion, onDiff }: { suggestion: Suggestion; onDiff: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const setStatus = useSetStatus();
  const apply = useApply();
  const diff = useDiff(open ? suggestion.id : null);
  const toast = useToast();
  const busy = setStatus.isPending || apply.isPending;

  const decide = (status: Status) =>
    setStatus.mutate(
      { id: suggestion.id, status },
      { onSuccess: () => toast.ok(`Marked ${status}`, suggestion.slug) },
    );

  return (
    <Disclosure
      open={open}
      onOpenChange={setOpen}
      summary={
        <span className="grid grid-cols-[2.5rem_1fr_auto] items-center gap-3">
          <span className="text-right font-mono text-sm font-bold tabular-nums text-ink-2">
            {suggestion.score || '—'}
          </span>
          <span className="truncate font-mono text-[0.8rem]">
            <span className="text-ink-3">{suggestion.skill} /</span> {suggestion.slug}
          </span>
          <span className="flex flex-wrap justify-end gap-1">
            {suggestion.type && <Chip tone={typeTone(suggestion.type)}>{suggestion.type}</Chip>}
            {suggestion.objective && (
              <Chip tone={objectiveTone(suggestion.objective)}>{suggestion.objective}</Chip>
            )}
            {suggestion.rung !== null && <Chip>rung {suggestion.rung}</Chip>}
            <Gauge tone={severityTone(suggestion.severity)} label={suggestion.severity || 'unrated'} />
            {suggestion.recurrences > 0 && <Chip tone="rust">&times;{suggestion.incidents}</Chip>}
            <Chip tone={statusTone(suggestion.status)}>{suggestion.status}</Chip>
          </span>
        </span>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-ink-2">
        {suggestion.context && (
          <div>
            <Eyebrow>context</Eyebrow>
            <p className="mt-1">{suggestion.context}</p>
          </div>
        )}
        <div>
          <Eyebrow>suggestion</Eyebrow>
          <p className="mt-1">{suggestion.suggestion || 'No suggestion body.'}</p>
        </div>

        {suggestion.missing.length > 0 && (
          <div>
            <Eyebrow>needs triage</Eyebrow>
            <p className="mt-1 text-ink-3">
              missing {suggestion.missing.join(', ')} — labels come from a{' '}
              <code className="font-mono">/kaizen:triage</code> pass, never guessed here
            </p>
          </div>
        )}

        <div>
          <Eyebrow>proposal</Eyebrow>
          {diff.isLoading ? (
            <p className="mt-1 text-ink-3">loading…</p>
          ) : diff.data?.patch ? (
            <p className="mt-1">
              A patch exists.{' '}
              <button
                type="button"
                onClick={() => onDiff(suggestion.id)}
                className="font-mono text-xs text-accent-ink underline underline-offset-2"
              >
                view diff
              </button>
            </p>
          ) : (
            <p className="mt-1 text-ink-3">Not yet drafted — a triage pass writes the patch.</p>
          )}
        </div>

        <div>
          <Eyebrow>file</Eyebrow>
          <code className="mt-1 block font-mono text-xs break-all text-ink-3">{suggestion.file}</code>
        </div>

        <ErrorNote error={setStatus.error ?? apply.error} />

        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || suggestion.status === 'approved'} onClick={() => decide('approved')}>
            Approve
          </Button>
          <Button
            variant="ghost"
            disabled={busy || suggestion.status === 'rejected'}
            onClick={() => decide('rejected')}
          >
            Reject
          </Button>
          <Button
            variant="ghost"
            disabled={busy || !diff.data?.patch}
            title={diff.data?.patch ? 'Apply the patch and commit' : 'No patch to apply yet'}
            onClick={() =>
              apply.mutate(
                { id: suggestion.id },
                { onSuccess: (r) => toast.ok('Applied', `commit ${r.sha.slice(0, 8)}`) },
              )
            }
          >
            Apply
          </Button>
        </div>
      </div>
    </Disclosure>
  );
}

export default function Queue({ state }: { state: State }) {
  const [filters, setFilters] = useState<Partial<Record<Facet, string>>>({});
  const [query, setQuery] = useState('');
  const [diffId, setDiffId] = useState<string | null>(null);
  const diff = useDiff(diffId);

  const options = useMemo(() => {
    const out = {} as Record<Facet, { value: string; label: string }[]>;
    for (const facet of FACETS) {
      const values = [...new Set(state.suggestions.map((s) => facetValue(s, facet)).filter(Boolean))].sort();
      out[facet] = [
        { value: '', label: `${facet}: all` },
        ...values.map((v) => ({ value: v, label: `${facet}: ${v}` })),
      ];
    }
    return out;
  }, [state.suggestions]);

  const rows = useMemo(() => {
    const q = query.toLowerCase();
    return rankSuggestions(
      state.suggestions
        .filter((s) => FACETS.every((f) => !filters[f] || facetValue(s, f) === filters[f]))
        .filter((s) => !q || `${s.slug} ${s.skill} ${s.suggestion}`.toLowerCase().includes(q)),
    );
  }, [state.suggestions, filters, query]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {FACETS.map((facet) => (
          <Select
            key={facet}
            label={facet}
            value={filters[facet] ?? ''}
            onValueChange={(v) => setFilters((f) => ({ ...f, [facet]: v }))}
            options={options[facet]}
          />
        ))}
        <input
          type="search"
          aria-label="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search…"
          className="w-32 border border-line bg-surface px-2 py-1 font-mono text-xs text-ink"
        />
        <span className="ml-auto font-mono text-xs text-ink-3">
          <Tooltip content={SCORE_HELP}>
            {rows.length} of {state.suggestions.length}
          </Tooltip>
        </span>
      </div>

      {rows.length === 0 ? (
        <Empty>Nothing matches those filters.</Empty>
      ) : (
        <div className="border border-line">
          {rows.map((s) => (
            <Row key={s.id} suggestion={s} onDiff={setDiffId} />
          ))}
        </div>
      )}

      <Dialog
        open={Boolean(diffId)}
        onOpenChange={(o) => !o && setDiffId(null)}
        title="Proposed patch"
        description={diffId ?? undefined}
      >
        <pre className="font-mono text-[0.72rem] leading-relaxed whitespace-pre-wrap text-ink-2">
          {diff.data?.patch ?? 'loading…'}
        </pre>
      </Dialog>
    </div>
  );
}

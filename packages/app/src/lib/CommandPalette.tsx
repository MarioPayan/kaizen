import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { canTransition, rankSuggestions, useSetClusterStatus, useSetStatus, type State } from '@kaizen/data';
import { Dialog, useToast } from '@kaizen/ui';

/**
 * ⌘K.
 *
 * The justification for a command layer in a single-user tool is narrow but
 * real: the actions here are the same six every session, and the queue is long
 * enough that finding a row costs more than naming it. Anything reachable in one
 * click stays a click — this exists for the things that were three clicks and a
 * scroll.
 */

export type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return { open, setOpen };
}

export function CommandPalette({
  state,
  open,
  setOpen,
}: {
  state: State;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const navigate = useNavigate();
  const setStatus = useSetStatus();
  const setCluster = useSetClusterStatus();
  const toast = useToast();

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setCursor(0);
  }, [setOpen]);

  const commands = useMemo<Command[]>(() => {
    const go = (path: string, label: string, hint?: string): Command => ({
      id: `go:${path}`,
      label,
      hint,
      run: () => navigate(path),
    });

    const out: Command[] = [
      go('/queue', 'Go to queue'),
      go('/queue?group=cluster', 'Group by cluster'),
      go('/queue?status=recorded', 'Show only undecided', 'status: recorded'),
      go('/queue?rung=1', 'Show only rung 1', 'a script can fix these'),
      go('/queue?all=1', 'Show everything', 'including muted'),
      go('/skills', 'Go to skills'),
      go('/docs', 'Go to docs'),
      go('/settings', 'Go to settings'),
    ];

    // Approving a promoted cluster is the highest-value action in the app and
    // the most tedious to reach by pointer — it is why this palette exists.
    for (const c of state.clusters.filter((c) => c.promoted).slice(0, 8)) {
      out.push({
        id: `approve:${c.id}`,
        label: `Approve cluster ${c.id}`,
        hint: `${c.size} suggestions · ${c.incidents} incidents`,
        run: () =>
          setCluster.mutate(
            { id: c.id, status: 'approved' },
            {
              onSuccess: (r) => toast.ok(`Approved ${r.updated} suggestions`, c.id),
              onError: (e) => toast.fail('Could not approve', e.message),
            },
          ),
      });
    }

    // Jumping to a specific suggestion, by the words you remember about it.
    for (const s of rankSuggestions(state.suggestions).slice(0, 40)) {
      out.push({
        id: `open:${s.id}`,
        label: s.slug,
        hint: `${s.skill} · ${s.status}`,
        run: () => navigate(`/queue?q=${encodeURIComponent(s.slug)}`),
      });
      // Offered only when the model allows it, which today means `planned`.
      // Anything earlier still needs a plan behind it, and the server would
      // refuse — a command that always fails is worse than a missing one.
      if (canTransition(s.status, 'approved')) {
        out.push({
          id: `ok:${s.id}`,
          label: `Approve ${s.slug}`,
          hint: s.skill,
          run: () =>
            setStatus.mutate(
              { id: s.id, status: 'approved' },
              {
                onSuccess: () => toast.ok('Approved', s.slug),
                onError: (e) => toast.fail('Could not approve', e.message),
              },
            ),
        });
      }
    }
    return out;
  }, [state, navigate, setCluster, setStatus, toast]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 12);
    // Every term must appear somewhere. Subsequence matching would rank
    // "approve" above "approve cluster x" on a query of "apx" and that ordering
    // is impossible to predict, so: plain, boring, all-terms-present.
    const terms = q.split(/\s+/);
    return commands
      .filter((c) => {
        const hay = `${c.label} ${c.hint ?? ''}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .slice(0, 12);
  }, [commands, query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = matches[cursor];
      if (hit) {
        hit.run();
        close();
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())} title="Command">
      <div className="flex flex-col gap-2">
        <input
          autoFocus
          aria-label="Command"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // Reset here rather than in an effect on `query`: typing is the event
            // that invalidates the cursor, so this is where it belongs.
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Approve a cluster, jump to a suggestion, change the view…"
          className="w-full bg-transparent px-1 py-1 text-title text-ink outline-none placeholder:text-ink-3"
        />
        {matches.length === 0 ? (
          <p className="px-1 py-6 text-center text-meta text-ink-3">Nothing matches “{query}”.</p>
        ) : (
          <ul className="flex flex-col">
            {matches.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => {
                    c.run();
                    close();
                  }}
                  className={`flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left ${
                    i === cursor ? 'bg-selected text-ink' : 'text-ink-2'
                  }`}
                >
                  <span className="truncate">{c.label}</span>
                  {c.hint && (
                    <span className="ml-auto shrink-0 font-mono text-micro text-ink-3">{c.hint}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

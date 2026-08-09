/**
 * Covers what a broken render would hide: that approving a cluster is one action
 * rather than one per member, that an untriaged suggestion is shown as untriaged
 * rather than quietly given defaults, and that a refused decision rolls back
 * carrying the server's own words.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { HelpProvider, ToastProvider, TooltipProvider } from '@kaizen/ui';
import Queue from '../src/views/Queue';
import type { State, Suggestion } from '@kaizen/data';

const suggestion = (over: Partial<Suggestion>): Suggestion => ({
  id: 'user/demo/2026-01-01-a.md',
  file: '/tmp/a.md',
  target: 'user',
  skill: 'demo',
  date: '2026-01-01',
  slug: 'a-thing',
  severity: 'medium',
  status: 'planned',
  type: 'determinism',
  objective: 'bug',
  scope: '_lib/x.md',
  rung: 1,
  effort: 'S',
  clusterPin: '',
  appliedSha: '',
  recurrences: 0,
  incidents: 1,
  context: 'ctx',
  suggestion: 'do the thing',
  rationale: '',
  missing: [],
  triaged: true,
  surfaced: true,
  score: 3,
  ...over,
});

const state = (over: Partial<State> = {}): State => ({
  generatedAt: new Date().toISOString(),
  targets: [{ name: 'user', skills: '/s', feedback: '/f', writable: true }],
  warnings: [],
  skills: [],
  suggestions: [],
  clusters: [],
  orphans: [],
  metrics: {
    total: 0,
    open: 0,
    untriaged: 0,
    incidents: 0,
    recurrences: 0,
    clusters: 0,
    promotedClusters: 0,
    incidentsByRung: {},
    proseLines: 0,
    scriptCount: 0,
    incidentsPer100Lines: 0,
  },
  ...over,
});

/** Reads back the query string so URL-backed filters can be asserted on. */
function LocationProbe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

const wrap = (ui: React.ReactNode, path = '/queue') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <TooltipProvider>
          {/* Without HelpProvider every chip popover silently no-ops. */}
          <HelpProvider>
            <MemoryRouter initialEntries={[path]}>
              {ui}
              <LocationProbe />
            </MemoryRouter>
          </HelpProvider>
        </TooltipProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
};

/**
 * The row's expand trigger, by name.
 *
 * Not by position: chips explain themselves through a popover, and a popover
 * trigger is also a button carrying aria-expanded, so "the first collapsed
 * button" is no longer the first row.
 */
const allRows = () => screen.getAllByRole('button', { name: /demo/ });
const row = (slug: RegExp) => screen.getByRole('button', { name: slug });

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/api/cluster')) {
        return new Response(JSON.stringify({ id: 'c', status: 'approved', updated: 3 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ id: 'x', patch: null }), { status: 200 });
    }),
  );
});

const members = ['a', 'b', 'c'].map((k) =>
  suggestion({ id: `user/demo/${k}.md`, slug: `slug-${k}`, incidents: 2, recurrences: 1 }),
);
const withCluster = state({
  suggestions: members,
  clusters: [
    {
      id: 'origin-remote',
      pinned: false,
      members: members.map((m) => m.id),
      size: 3,
      incidents: 6,
      score: 18,
      skills: ['demo'],
      scopes: ['_lib/x.md'],
      first: '2026-01-01',
      last: '2026-03-01',
      spanDays: 59,
      promoted: true,
    },
  ],
});

describe('Queue, grouped by cluster', () => {
  it('approves every member in one action', async () => {
    const user = userEvent.setup();
    wrap(<Queue state={withCluster} />, '/queue?group=cluster');

    await user.click(screen.getByRole('button', { name: /approve all \(3\)/i }));

    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    const clusterCalls = calls.filter((c) => String(c[0]).includes('/api/cluster'));
    // One request for the group. Three would mean the UI reintroduced the
    // per-row clicking this tool exists to remove.
    expect(clusterCalls).toHaveLength(1);
    expect(JSON.parse(String(clusterCalls[0]?.[1]?.body))).toEqual({
      id: 'origin-remote',
      status: 'approved',
    });
  });

  it('marks a promoted cluster as needing a low-rung fix', () => {
    wrap(<Queue state={withCluster} />, '/queue?group=cluster');
    expect(screen.getByText(/fix at rung 0\/1/i)).toBeInTheDocument();
  });

  it('says so plainly when nothing has recurred', () => {
    wrap(<Queue state={state({ suggestions: [suggestion({})] })} />, '/queue?group=cluster');
    expect(screen.getByText(/no suggestion has been filed twice/i)).toBeInTheDocument();
  });
});

describe('Queue', () => {
  it('shows an untriaged suggestion as untriaged rather than defaulting it', async () => {
    const user = userEvent.setup();
    const untriaged = suggestion({
      severity: '',
      type: '',
      objective: '',
      rung: null,
      effort: '',
      missing: ['severity', 'type', 'objective', 'effort', 'rung'],
      triaged: false,
      score: 0,
    });
    wrap(<Queue state={state({ suggestions: [untriaged] })} />);

    await user.click(row(/a-thing/));
    expect(screen.getByText(/missing severity, type, objective/i)).toBeInTheDocument();
    // Severity is a dot now, not a word — but an unrated item still has to say
    // so to anything that cannot see the colour.
    expect(screen.getAllByRole('img', { name: 'unrated' })).not.toHaveLength(0);
  });

  /**
   * A button whose only outcome is a 409 reads as a broken app rather than as a
   * plan that is still owed. `recorded` is where 22 real suggestions sit, and
   * approving one is not a legal move until a plan exists behind it.
   */
  it('will not offer a decision the model does not allow', async () => {
    const user = userEvent.setup();
    wrap(<Queue state={state({ suggestions: [suggestion({ status: 'recorded' })] })} />);

    await user.click(row(/a-thing/));
    const approve = screen.getByRole('button', { name: /^approve$/i });

    // `aria-disabled`, not the native attribute: Button sets
    // `focusableWhenDisabled` on purpose so the explanation in `title` stays
    // reachable by keyboard. Asserted on behaviour too, since that is the part
    // that matters — the click must not reach the server.
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    expect(approve).toHaveAttribute('title', expect.stringContaining('recorded cannot become approved'));
    expect(approve).toHaveAttribute('title', expect.stringContaining('triaged'));

    await user.click(approve);
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    expect(calls.filter((c) => String(c[0]).includes('/api/suggestion'))).toHaveLength(0);

    // Rejecting is legal from anywhere before the decision, and stays offered.
    expect(screen.getByRole('button', { name: /^reject$/i })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('offers the decision once a plan is behind it', async () => {
    const user = userEvent.setup();
    wrap(<Queue state={state({ suggestions: [suggestion({ status: 'planned' })] })} />);
    await user.click(row(/a-thing/));
    expect(screen.getByRole('button', { name: /^approve$/i })).not.toBeDisabled();
  });

  it('ranks by score, highest first', () => {
    const rows = [
      suggestion({ id: 'user/demo/low.md', slug: 'low-value', score: 1 }),
      suggestion({ id: 'user/demo/high.md', slug: 'high-value', score: 21, incidents: 7 }),
    ];
    wrap(<Queue state={state({ suggestions: rows })} />);
    expect(within(allRows()[0]!).getByText(/high-value/)).toBeInTheDocument();
  });

  it('filters by type, and the filter lands in the URL', async () => {
    const user = userEvent.setup();
    const rows = [
      suggestion({ id: 'user/demo/1.md', slug: 'det-one', type: 'determinism' }),
      suggestion({ id: 'user/demo/2.md', slug: 'hyg-two', type: 'hygiene' }),
    ];
    wrap(<Queue state={state({ suggestions: rows })} />);

    // The filter is a listbox popup, not a native select.
    await user.click(screen.getByRole('combobox', { name: 'type' }));
    await user.click(await screen.findByRole('option', { name: 'type: hygiene' }));

    await waitFor(() => expect(screen.queryByText(/det-one/)).not.toBeInTheDocument());
    expect(screen.getByText(/hyg-two/)).toBeInTheDocument();
    // Shareable and reload-proof, which is the point of putting it there.
    expect(screen.getByTestId('search').textContent).toContain('type=hygiene');
  });

  it('opens on what you asked to see, and offers the rest', async () => {
    const user = userEvent.setup();
    const rows = [
      suggestion({ id: 'user/demo/1.md', slug: 'wanted' }),
      suggestion({ id: 'user/demo/2.md', slug: 'muted-one', surfaced: false }),
      suggestion({ id: 'user/demo/3.md', slug: 'muted-two', surfaced: false }),
    ];
    wrap(<Queue state={state({ suggestions: rows })} />);

    expect(screen.queryByText(/muted-one/)).not.toBeInTheDocument();
    expect(screen.getByText(/2 muted by your surface settings/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show everything/i }));
    // Nothing was deleted — it was one click away the whole time.
    expect(await screen.findByText(/muted-one/)).toBeInTheDocument();
    expect(screen.getByTestId('search').textContent).toContain('all=1');
  });

  it('rolls a refused decision back and shows what the server said', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/api/suggestion')) {
          return new Response(
            JSON.stringify({ error: 'working tree is not clean — commit or stash first: a.md' }),
            { status: 409 },
          );
        }
        return new Response(JSON.stringify({ id: 'x', patch: null }), { status: 200 });
      }),
    );
    wrap(<Queue state={state({ suggestions: [suggestion({})] })} />);

    await user.click(row(/a-thing/));
    await user.click(screen.getByRole('button', { name: /^approve$/i }));

    // The optimistic flip is rolled back...
    await waitFor(() => expect(screen.getByText(/^planned$/)).toBeInTheDocument());
    // ...and the server's own wording survives the rollback, which is the part
    // that tells you what to do next. It lands in two places on purpose: the
    // toast catches your eye, the note stays put while you fix it.
    expect(await screen.findAllByText(/commit or stash first: a\.md/i)).not.toHaveLength(0);
  });
});

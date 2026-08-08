/**
 * Covers the two things a broken render would hide: that approving a cluster is
 * one action rather than one per member, and that an untriaged suggestion is
 * shown as untriaged rather than quietly given defaults.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Clusters from '../src/views/Clusters';
import Queue from '../src/views/Queue';
import type { State, Suggestion } from '../src/types';

const suggestion = (over: Partial<Suggestion>): Suggestion => ({
  id: 'user/demo/2026-01-01-a.md',
  file: '/tmp/a.md',
  target: 'user',
  skill: 'demo',
  date: '2026-01-01',
  slug: 'a-thing',
  severity: 'medium',
  status: 'new',
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

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
};

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

describe('Clusters', () => {
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

  it('approves every member in one action', async () => {
    const user = userEvent.setup();
    wrap(<Clusters state={withCluster} />);

    await user.click(screen.getByRole('button', { name: /approve cluster \(3\)/i }));

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
    wrap(<Clusters state={withCluster} />);
    expect(screen.getByText(/fix at rung 0\/1/i)).toBeInTheDocument();
  });

  it('says so plainly when nothing has recurred', () => {
    wrap(<Clusters state={state()} />);
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

    await user.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText(/missing severity, type, objective/i)).toBeInTheDocument();
    expect(screen.getByText(/unrated/i)).toBeInTheDocument();
  });

  it('ranks by score, highest first', () => {
    const rows = [
      suggestion({ id: 'user/demo/low.md', slug: 'low-value', score: 1 }),
      suggestion({ id: 'user/demo/high.md', slug: 'high-value', score: 21, incidents: 7 }),
    ];
    wrap(<Queue state={state({ suggestions: rows })} />);
    const buttons = screen.getAllByRole('button', { expanded: false });
    expect(within(buttons[0]!).getByText(/high-value/)).toBeInTheDocument();
  });

  it('filters by type', async () => {
    const user = userEvent.setup();
    const rows = [
      suggestion({ id: 'user/demo/1.md', slug: 'det-one', type: 'determinism' }),
      suggestion({ id: 'user/demo/2.md', slug: 'hyg-two', type: 'hygiene' }),
    ];
    wrap(<Queue state={state({ suggestions: rows })} />);
    await user.selectOptions(screen.getByLabelText('type'), 'hygiene');
    expect(screen.queryByText(/det-one/)).not.toBeInTheDocument();
    expect(screen.getByText(/hyg-two/)).toBeInTheDocument();
  });
});

/**
 * Boots the real API over a real temp skills tree and renders the real App
 * against it. No mocked fetch, no hand-written state fixture — if the scanner and
 * the UI ever disagree about a field name, this fails and the unit tests do not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/index.mjs';
import App from '../src/App';

let server: Server;
let root: string;
let origin: string;

const suggestion = (slug: string, extra = '') =>
  [
    '---',
    'skill: demo',
    `date: 2026-0${extra ? '3' : '1'}-01`,
    'severity: medium',
    'effort: S',
    'type: determinism',
    'objective: bug',
    'scope: _lib/workspace.md',
    'rung: 1',
    '---',
    '',
    '## Context',
    '',
    'The git remote is not always named origin when resolving the clone.',
    '',
    '## Suggestion',
    '',
    `Resolve the remote by matching owner and repo across every configured remote. (${slug})`,
    '',
    extra,
  ].join('\n');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaizen-int-'));
  const skills = join(root, 'skills');
  const feedback = join(root, 'skills-feedback');
  mkdirSync(join(skills, 'demo'), { recursive: true });
  mkdirSync(join(feedback, 'demo'), { recursive: true });
  writeFileSync(
    join(skills, 'demo', 'SKILL.md'),
    '---\nname: demo\n---\n\n# Demo skill\n\nA paragraph of instructions.\n',
  );
  for (const [i, slug] of ['alpha', 'beta', 'gamma'].entries()) {
    writeFileSync(
      join(feedback, 'demo', `2026-0${i + 1}-01-remote-origin-${slug}.md`),
      suggestion(slug, i === 0 ? '## Recurrence — 2026-04-01\n\nHappened again.\n' : ''),
    );
  }

  server = createApp({
    targets: [{ name: 'user', skills, feedback, writable: true }],
    scan: { enabled: false, roots: [], depth: 3, writable: false },
    clusterPromotion: { members: 3, incidents: 5 },
    applyGuards: { requireCleanTree: true, requireDiffApplies: true },
    autoApply: [],
    models: {},
    cadence: { weekly: 'SUN 09:00', sessionHook: true },
    server: { host: '127.0.0.1', port: 0 },
  }) as Server;

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  // The app fetches relative paths; jsdom has no origin to resolve them against.
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    real(typeof input === 'string' && input.startsWith('/') ? origin + input : input, init)) as typeof fetch;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

const mount = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/queue']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('app against a live server', () => {
  /** A stat tile is a value followed by its label; read the pair, not a loose number. */
  const statFor = (label: string) =>
    screen.getByText(label).parentElement?.querySelector('span')?.textContent;

  it('renders counts that come from the scanner, not from the UI', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('suggestions on disk')).toBeInTheDocument());
    // Three files, one of which recurred once, so four incidents. Both numbers
    // are computed by the scanner — the UI must not be deriving its own.
    expect(statFor('suggestions on disk')).toBe('3');
    expect(statFor('incidents incl. recurrences')).toBe('4');
    expect(statFor('clusters past threshold')).toBe('1');
  });

  it('shows the cluster the scanner discovered, promoted', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Clusters' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Clusters' }));

    // Three suggestions sharing a scope and vocabulary must group, and three
    // members crosses the promotion threshold.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /approve cluster \(3\)/i })).toBeInTheDocument(),
    );
    expect(screen.getByText(/fix at rung 0\/1/i)).toBeInTheDocument();
  });

  it('renders a skill markdown file read from disk', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Skills' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Skills' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Demo skill' })).toBeInTheDocument());
    expect(screen.getByText('A paragraph of instructions.')).toBeInTheDocument();
  });

  it('loads the settings form from the live config', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Settings' }));
    await waitFor(() => expect(screen.getByLabelText('triage')).toBeInTheDocument());
    expect(screen.getByLabelText('auto-apply')).toHaveValue('');
  });
});

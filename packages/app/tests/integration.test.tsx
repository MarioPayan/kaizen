/**
 * Boots the real API over a real temp skills tree and renders the real App
 * against it. No mocked fetch, no hand-written state fixture — if the scanner and
 * the UI ever disagree about a field name, this fails and the unit tests do not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { HelpProvider, ToastProvider, TooltipProvider } from '@kaizen/ui';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '@kaizen/server';
import App from '../src/App';
import { TYPE_HELP } from '../src/lib/taxonomy';

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

const mount = (path = '/queue') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <TooltipProvider>
          <HelpProvider>
            <MemoryRouter initialEntries={[path]}>
              <App />
            </MemoryRouter>
          </HelpProvider>
        </TooltipProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
};

describe('app against a live server', () => {
  it('renders counts that come from the scanner, not from the UI', async () => {
    mount();
    // Three files, all open and all undecided. The header reports what the
    // scanner computed; the UI must never be deriving its own totals.
    await waitFor(() => expect(screen.getByRole('banner')).toHaveTextContent(/open/));
    expect(screen.getByRole('banner')).toHaveTextContent('3 open · 3 to decide');
  });

  it('is exactly four views', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('navigation')).toBeInTheDocument());
    // A view that quietly comes back is the failure this restructure exists to
    // prevent; the count is the cheapest way to notice.
    const views = within(screen.getByRole('navigation')).getAllByRole('button');
    expect(views.map((v) => v.textContent)).toEqual(['queue', 'skills', 'docs', 'settings']);
  });

  it('shows the cluster the scanner discovered, promoted', async () => {
    // No clicking: mounting straight at the URL proves the filter round-trips
    // through the query string, which is the whole point of putting it there.
    mount('/queue?group=cluster');

    // Three suggestions sharing a scope and vocabulary must group, and three
    // members crosses the promotion threshold.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /approve all \(3\)/i })).toBeInTheDocument(),
    );
    expect(screen.getByText(/fix at rung 0\/1/i)).toBeInTheDocument();
  });

  it('explains a chip with the same sentence the Docs page uses', async () => {
    const user = userEvent.setup();
    mount('/docs');
    // One source of truth, asserted: the constant is rendered on Docs...
    await waitFor(() => expect(screen.getByText(TYPE_HELP.determinism!)).toBeInTheDocument());

    mount();
    // The type label is abbreviated in the row tail; the popover carries the full
    // sentence either way.
    await user.click((await screen.findAllByRole('button', { name: /^dete/ }))[0]!);
    // ...and the popover on the chip cannot disagree with it.
    expect(await screen.findAllByText(TYPE_HELP.determinism!)).not.toHaveLength(0);
  });

  it('renders a skill markdown file read from disk', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: 'skills' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Demo skill' })).toBeInTheDocument());
    expect(screen.getByText('A paragraph of instructions.')).toBeInTheDocument();
  });

  it('loads the settings form from the live config', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: 'settings' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'triage' })).toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: 'auto-apply' })).toBeInTheDocument();
    // Booleans are switches now, not two-option dropdowns.
    expect(screen.getByRole('switch', { name: 'session line' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'clean tree' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'scan projects' })).toBeInTheDocument();
  });

  it('adds and removes a scan root as list rows', async () => {
    const user = userEvent.setup();
    mount('/settings');
    await user.click(await screen.findByRole('switch', { name: 'scan projects' }));

    await user.click(screen.getByRole('button', { name: 'add root' }));
    // A path with a comma in it, which the old comma-joined text box destroyed.
    await user.type(screen.getByRole('textbox', { name: 'scan root 1' }), '/tmp/a,b');
    expect(screen.getByRole('textbox', { name: 'scan root 1' })).toHaveValue('/tmp/a,b');

    await user.click(screen.getByRole('button', { name: /^remove$/i }));
    expect(screen.queryByRole('textbox', { name: 'scan root 1' })).not.toBeInTheDocument();
  });
});

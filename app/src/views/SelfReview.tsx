import type { State } from '../types';
import { Chip, Panel } from '../components/ui';

/**
 * The app is not exempt from the loop it runs.
 *
 * It is `scope: app/` and files into the `kaizen-app` folder through the same
 * pipeline as any skill. That only means something because this is a real
 * project: type checking, linting, tests and bundle size are rung-1 signals a
 * generated page never had.
 */

const RUNG1 = [
  ['npm --prefix app run check', 'types, lint, formatting and tests in one gate'],
  ['bundle size per route', 'tracked per commit; a regression files itself'],
  ['unrendered components', 'anything no route reaches is a deletion candidate'],
  ['/api/state response time', 'past ~300ms something needs caching or cutting'],
];

const RUNG2 = [
  'Has any view gone unopened for 30 days? Delete it.',
  'Did a question need answering outside the app? That is a missing column.',
  'Has anything sat at proposed for two weeks? The approval flow has friction.',
  'Is any number on screen not traceable to a file on disk?',
];

const SEEDED = [
  {
    slug: 'no-syntax-highlighting-in-skill-viewer',
    type: 'tooling',
    objective: 'clarity',
    body: 'SKILL.md files are mostly bash and JSON blocks, rendered unhighlighted. Shiki would fix it at roughly 200KB of bundle. Deferred deliberately: readability is already decent with typographic styling alone, and this is exactly the kind of call worth making with usage rather than taste.',
  },
  {
    slug: 'server-lifecycle-orphan-risk',
    type: 'tooling',
    objective: 'bug',
    body: 'A local API can outlive the session that started it. /api/health lets the hook tell running from stale, but there is no pidfile or heartbeat yet — the github_triage.sh pattern already in use is the model to copy.',
  },
  {
    slug: 'no-realtime-refresh-on-file-change',
    type: 'tooling',
    objective: 'feature',
    body: 'State refetches on window focus. A watcher would be live, but the underlying files change when a skill runs — a handful of times a day — so polling a directory continuously would cost more than it returns.',
  },
];

export default function SelfReview({ state }: { state: State }) {
  const appSuggestions = state.suggestions.filter((s) => s.skill === 'kaizen-app');

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-sm text-ink-2">
        The app runs the same loop against itself. It is <code className="font-mono">scope: app/</code> and
        files into <code className="font-mono">skills-feedback/kaizen-app/</code> — no separate machinery, no
        exemption.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel>
          <h3 className="mb-2 font-mono text-sm font-bold">Rung-1 checks it runs on itself</h3>
          <ul className="flex flex-col gap-2">
            {RUNG1.map(([cmd, why]) => (
              <li key={cmd} className="text-sm">
                <code className="font-mono text-xs text-accent-ink">{cmd}</code>
                <span className="mt-0.5 block text-xs text-ink-3">{why}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel>
          <h3 className="mb-2 font-mono text-sm font-bold">Rung-2 questions each pass</h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-ink-2 marker:text-ink-3">
            {RUNG2.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel>
        <h3 className="mb-1 font-mono text-sm font-bold">
          Known limitations, recorded before anyone hit them
        </h3>
        <p className="mb-3 text-xs text-ink-3">
          Deliberate omissions belong in the ledger, not in a comment nobody reads. Each is a real entry with
          a reason to revisit.
        </p>
        <ul className="flex flex-col gap-3">
          {SEEDED.map((s) => (
            <li key={s.slug} className="border-l-2 border-line pl-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-xs">{s.slug}</span>
                <Chip>{s.type}</Chip>
                <Chip tone={s.objective === 'bug' ? 'rust' : 'brass'}>{s.objective}</Chip>
              </div>
              <p className="mt-1 text-sm text-ink-2">{s.body}</p>
            </li>
          ))}
        </ul>
      </Panel>

      {appSuggestions.length > 0 && (
        <Panel>
          <h3 className="mb-2 font-mono text-sm font-bold">
            Filed against this app ({appSuggestions.length})
          </h3>
          <ul className="flex flex-col gap-1.5">
            {appSuggestions.map((s) => (
              <li key={s.id} className="flex items-baseline gap-2 font-mono text-xs">
                <span className="text-ink-3">{s.date}</span>
                <span>{s.slug}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

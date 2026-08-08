import { useNavigate, useLocation } from 'react-router-dom';
import { collapsedWorktrees, useKaizenState, type State } from '@kaizen/data';
import { Note, Stat, TabPanel, Tabs, Tooltip } from '@kaizen/ui';
import Queue from './views/Queue';
import Clusters from './views/Clusters';
import Skills from './views/Skills';
import Determinism from './views/Determinism';
import Settings from './views/Settings';
import SelfReview from './views/SelfReview';

const TABS = ['queue', 'clusters', 'skills', 'determinism', 'settings', 'self'] as const;
type Tab = (typeof TABS)[number];

const LABELS: Record<Tab, string> = {
  queue: 'Queue',
  clusters: 'Clusters',
  skills: 'Skills',
  determinism: 'Determinism',
  settings: 'Settings',
  self: 'This app',
};

function Header({ state }: { state: State }) {
  const { metrics } = state;
  const collapsed = collapsedWorktrees(state);
  return (
    <header className="border-b border-line">
      <div className="mx-auto max-w-6xl px-5 pt-8 pb-5">
        <h1 className="font-mono text-2xl font-bold tracking-tight">kaizen</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-2">
          What your skills have already told you, ranked — and a bias toward fixing it in a script rather than
          another paragraph.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
          <Stat value={metrics.total} label="suggestions on disk" />
          <Stat
            value={metrics.incidents}
            label="incidents incl. recurrences"
            tone="rust"
            hint={`${metrics.recurrences} of these are repeats of something already filed`}
          />
          <Stat value={metrics.untriaged} label="untriaged" tone={metrics.untriaged ? 'brass' : 'accent'} />
          <Stat value={metrics.promotedClusters} label="clusters past threshold" tone="brass" />
          <Stat value={metrics.scriptCount} label="scripts across all skills" tone="accent" />
        </div>

        {state.warnings.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1">
            {state.warnings.map((w) => (
              <li key={w}>
                <Note>{w}</Note>
              </li>
            ))}
          </ul>
        )}

        {collapsed > 0 && (
          <p className="mt-3 text-xs text-ink-3">
            <Tooltip content="A worktree holds the same files as its main repo, so listing it again would say nothing new.">
              {collapsed} git worktrees collapsed
            </Tooltip>{' '}
            into {state.skills.filter((s) => s.worktrees).length} repositories.
          </p>
        )}
      </div>
    </header>
  );
}

export default function App() {
  const { data: state, isLoading, error } = useKaizenState();
  const navigate = useNavigate();
  const location = useLocation();

  const current = (TABS.find((t) => location.pathname === `/${t}`) ?? 'queue') as Tab;

  if (isLoading) return <p className="p-8 font-mono text-sm text-ink-3">reading skills…</p>;

  if (error || !state) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="font-mono text-lg font-bold">kaizen could not read your skills</h1>
        <p className="mt-2 text-sm text-ink-2">{(error as Error)?.message ?? 'No state returned.'}</p>
        <p className="mt-3 text-sm text-ink-2">
          If this is a first run, set up targets with <code className="font-mono text-xs">/kaizen:init</code>.
          Nothing is assumed about where skills live on this machine.
        </p>
      </div>
    );
  }

  const counts: Partial<Record<Tab, number>> = {
    queue: state.metrics.total,
    clusters: state.clusters.filter((c) => c.size > 1).length,
    skills: state.skills.length,
  };

  return (
    <div className="min-h-screen">
      <Header state={state} />

      <main className="mx-auto max-w-6xl px-5 pb-10">
        <Tabs
          value={current}
          onValueChange={(v) => navigate(`/${v}`)}
          items={TABS.map((t) => ({ value: t, label: LABELS[t], count: counts[t] }))}
        >
          <TabPanel value="queue">
            <Queue state={state} />
          </TabPanel>
          <TabPanel value="clusters">
            <Clusters state={state} />
          </TabPanel>
          <TabPanel value="skills">
            <Skills state={state} />
          </TabPanel>
          <TabPanel value="determinism">
            <Determinism state={state} />
          </TabPanel>
          <TabPanel value="settings">
            <Settings />
          </TabPanel>
          <TabPanel value="self">
            <SelfReview state={state} />
          </TabPanel>
        </Tabs>
      </main>

      <footer className="mx-auto max-w-6xl px-5 pb-10 font-mono text-[0.68rem] text-ink-3">
        read in place from {state.targets.map((t) => t.skills).join(', ') || 'no targets'} · generated{' '}
        {new Date(state.generatedAt).toLocaleTimeString()}
      </footer>
    </div>
  );
}

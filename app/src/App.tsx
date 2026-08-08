import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useState_ } from './api';
import { Stat } from './components/ui';
import Queue from './views/Queue';
import Clusters from './views/Clusters';
import Skills from './views/Skills';
import Determinism from './views/Determinism';
import Settings from './views/Settings';
import SelfReview from './views/SelfReview';
import type { State } from './types';

const TABS = [
  { to: '/queue', label: 'Queue' },
  { to: '/clusters', label: 'Clusters' },
  { to: '/skills', label: 'Skills' },
  { to: '/determinism', label: 'Determinism' },
  { to: '/settings', label: 'Settings' },
  { to: '/self', label: 'This app' },
] as const;

function Header({ state }: { state: State }) {
  const { metrics } = state;
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
          <Stat value={metrics.incidents} label="incidents incl. recurrences" tone="rust" />
          <Stat value={metrics.untriaged} label="untriaged" tone={metrics.untriaged ? 'brass' : 'accent'} />
          <Stat value={metrics.promotedClusters} label="clusters past threshold" tone="brass" />
          <Stat value={metrics.scriptCount} label="scripts across all skills" tone="accent" />
        </div>
        {state.warnings.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1">
            {state.warnings.map((w) => (
              <li key={w} className="border-l-2 border-brass bg-brass-soft px-3 py-1.5 text-xs text-brass">
                {w}
              </li>
            ))}
          </ul>
        )}
      </div>
    </header>
  );
}

export default function App() {
  const { data: state, isLoading, error } = useState_();

  if (isLoading) {
    return <p className="p-8 font-mono text-sm text-ink-3">reading skills…</p>;
  }

  if (error || !state) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="font-mono text-lg font-bold">kaizen could not read your skills</h1>
        <p className="mt-2 text-sm text-ink-2">{(error as Error)?.message ?? 'No state returned.'}</p>
        <p className="mt-3 text-sm text-ink-2">
          If this is a first run, set up targets with <code className="font-mono text-xs">/kaizen-init</code>.
          Nothing is assumed about where skills live on this machine.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header state={state} />

      <nav className="border-b border-line">
        <div className="mx-auto flex max-w-6xl gap-0 overflow-x-auto px-5">
          {TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              className={({ isActive }) =>
                `border-b-2 px-4 py-2.5 font-mono text-[0.78rem] font-semibold whitespace-nowrap transition ${
                  isActive
                    ? 'border-accent text-ink'
                    : 'border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink'
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-5 py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/queue" replace />} />
          <Route path="/queue" element={<Queue state={state} />} />
          <Route path="/clusters" element={<Clusters state={state} />} />
          <Route path="/skills" element={<Skills state={state} />} />
          <Route path="/determinism" element={<Determinism state={state} />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/self" element={<SelfReview state={state} />} />
          <Route path="*" element={<Navigate to="/queue" replace />} />
        </Routes>
      </main>

      <footer className="mx-auto max-w-6xl px-5 pt-2 pb-10 font-mono text-[0.68rem] text-ink-3">
        read in place from {state.targets.map((t) => t.skills).join(', ') || 'no targets'} · generated{' '}
        {new Date(state.generatedAt).toLocaleTimeString()}
      </footer>
    </div>
  );
}

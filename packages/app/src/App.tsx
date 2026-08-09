import { useNavigate, useLocation } from 'react-router-dom';
import { useKaizenState, useLiveUpdates, type State } from '@kaizen/data';
import { Key, Live } from '@kaizen/ui';
import Queue from './views/Queue';
import Skills from './views/Skills';
import Docs from './views/Docs';
import Settings from './views/Settings';
import { CommandPalette, useCommandPalette } from './lib/CommandPalette';

const TABS = ['queue', 'skills', 'docs', 'settings'] as const;
type Tab = (typeof TABS)[number];

/**
 * A tool you keep open, not one you visit.
 *
 * There is no masthead and no stat wall. Both were paid for in vertical space
 * every single time the page loaded, and both said the same thing they said
 * yesterday. What replaces them is one line: where you are, whether the data is
 * live, and what the keyboard will do. Everything else is the list.
 */
function TopBar({ state, live, tab }: { state: State; live: boolean; tab: Tab }) {
  const navigate = useNavigate();
  const location = useLocation();
  const open = state.suggestions.filter((s) => s.surfaced && s.status !== 'applied').length;
  const decide = state.suggestions.filter((s) => s.status === 'recorded' || s.status === 'planned').length;

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3 py-1.5">
      <span className="font-semibold tracking-tight">kaizen</span>

      <nav className="flex items-center gap-px text-ink-3">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            // Filters live in the query string; a round trip through another tab
            // should not throw them away.
            onClick={() => navigate({ pathname: `/${t}`, search: location.search })}
            className={`rounded-sm px-1.5 py-0.5 transition-colors hover:text-ink ${
              t === tab ? 'bg-selected text-ink' : ''
            }`}
          >
            {t}
          </button>
        ))}
      </nav>

      <span className="ml-auto flex items-center gap-3 text-micro text-ink-3">
        <span className="tabular-nums">
          <span className="text-ink-2">{open}</span> open · <span className="text-ink-2">{decide}</span> to
          decide
        </span>
        <span className="flex items-center gap-1.5">
          <Live on={live} label={live ? 'live' : 'not receiving updates'} />
          {live ? 'live' : `last read ${new Date(state.generatedAt).toLocaleTimeString()}`}
        </span>
        <span className="hidden items-center gap-1 sm:flex">
          <Key>⌘K</Key>
          <Key>J</Key>
          <Key>K</Key>
          <Key>A</Key>
        </span>
      </span>
    </header>
  );
}

export default function App() {
  const { data: state, isLoading, error } = useKaizenState();
  const live = useLiveUpdates();
  const location = useLocation();
  const palette = useCommandPalette();

  const tab = (TABS.find((t) => location.pathname === `/${t}`) ?? 'queue') as Tab;

  if (isLoading) return <p className="p-6 font-mono text-meta text-ink-3">reading skills…</p>;

  if (error || !state) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-title font-semibold">kaizen could not read your skills</h1>
        <p className="mt-2 text-meta text-ink-2">{(error as Error)?.message ?? 'No state returned.'}</p>
        <p className="mt-3 text-meta text-ink-2">
          If this is a first run, set up targets with <code className="font-mono">/kaizen:init</code>. Nothing
          is assumed about where skills live on this machine.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar state={state} live={live} tab={tab} />
      <main className="min-h-0 flex-1">
        {tab === 'queue' && <Queue state={state} />}
        {tab === 'skills' && <Skills state={state} />}
        {tab === 'docs' && <Docs />}
        {tab === 'settings' && <Settings />}
      </main>
      <CommandPalette state={state} {...palette} />
    </div>
  );
}

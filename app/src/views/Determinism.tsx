import { Bar, Chip, Empty, Panel } from '../components/ui';
import type { State } from '../types';

const RUNGS = [
  {
    n: 0,
    title: 'Harness enforces it',
    detail: 'A hook, a permission rule, a CLAUDE.md line. Cannot drift, cannot be skipped.',
    cost: '0 tokens',
  },
  {
    n: 1,
    title: 'A script decides',
    detail: 'Shell in _lib returning a verdict. Testable, greppable, identical every run.',
    cost: 'one Bash call',
  },
  {
    n: 2,
    title: 'A written rule',
    detail: 'Prose re-read and re-interpreted every run. Fine when the input genuinely varies.',
    cost: 'tokens every run',
  },
  {
    n: 3,
    title: 'Left to reasoning',
    detail: 'Nothing written down. Where most recorded failures came from.',
    cost: 'tokens + drift',
  },
] as const;

const RUNG_COLOR = ['text-accent', 'text-accent', 'text-brass', 'text-rust'] as const;

export default function Determinism({ state }: { state: State }) {
  const byRung = state.metrics.incidentsByRung;
  const rungValues = [0, 1, 2, 3].map((n) => byRung[String(n)] ?? 0);
  const maxRung = Math.max(1, ...rungValues);

  // Clusters whose fix belongs in a script are the conversion candidates: each one
  // is a number of incidents that stop being possible once the script exists.
  const candidates = state.clusters
    .map((c) => {
      const members = state.suggestions.filter((s) => c.members.includes(s.id));
      const scriptable = members.filter((s) => s.rung !== null && s.rung <= 1);
      return {
        id: c.id,
        incidents: scriptable.reduce((sum, s) => sum + s.incidents, 0),
        scope: c.scopes[0] ?? '',
      };
    })
    .filter((c) => c.incidents > 0)
    .sort((a, b) => b.incidents - a.incidents)
    .slice(0, 8);

  const triagedAny = rungValues.some((v) => v > 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="mb-3 text-sm text-ink-2">
          Every fix is placed on a rung, and may not be applied higher than necessary. A proposal at rung 2 or
          3 has to say why the rung below it does not work.
        </p>
        <div className="flex flex-col gap-px border border-line bg-line">
          {RUNGS.map((r) => (
            <div
              key={r.n}
              className="grid grid-cols-[2rem_1fr_auto] items-baseline gap-4 bg-surface px-4 py-3"
            >
              <span className={`font-mono text-xl leading-none font-bold ${RUNG_COLOR[r.n]}`}>{r.n}</span>
              <span>
                <span className="block font-mono text-sm font-bold">{r.title}</span>
                <span className="mt-0.5 block text-[0.83rem] text-ink-2">{r.detail}</span>
              </span>
              <span className="font-mono text-[0.68rem] whitespace-nowrap text-ink-3">{r.cost}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 font-mono text-sm font-bold">Incidents by target rung</h3>
        {triagedAny ? (
          <div className="flex flex-col gap-2">
            {RUNGS.map((r) => (
              <Bar
                key={r.n}
                label={`rung ${r.n} — ${r.title.toLowerCase()}`}
                value={rungValues[r.n] ?? 0}
                max={maxRung}
                tone={r.n <= 1 ? 'accent' : r.n === 2 ? 'brass' : 'rust'}
              />
            ))}
          </div>
        ) : (
          <Empty>
            Nothing is triaged yet, so no rung has been assigned. Run{' '}
            <code className="font-mono">/kaizen</code> to assign them.
          </Empty>
        )}
      </div>

      <div>
        <h3 className="mb-2 font-mono text-sm font-bold">Conversion candidates</h3>
        <p className="mb-3 text-sm text-ink-2">
          Clusters whose fix belongs in a script. The number is how many recorded incidents stop being
          possible once it exists.
        </p>
        {candidates.length === 0 ? (
          <Empty>None identified yet — triage assigns the rung that puts them here.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {candidates.map((c) => (
              <Bar
                key={c.id}
                label={c.scope || c.id}
                value={c.incidents}
                max={candidates[0]?.incidents ?? 1}
              />
            ))}
          </div>
        )}
      </div>

      <Panel>
        <h3 className="font-mono text-sm font-bold">Where prose concentrates</h3>
        <p className="mt-1 text-sm text-ink-2">
          {state.metrics.proseLines.toLocaleString()} lines of instruction across {state.skills.length} skills
          and modules, against {state.metrics.scriptCount} scripts. The ratio worth watching is failures per
          100 lines of prose — currently{' '}
          <span className="font-mono font-bold">{state.metrics.incidentsPer100Lines}</span> incidents per 100
          lines.
        </p>
        <p className="mt-2 text-xs text-ink-3">
          <Chip tone="brass">note</Chip> This is a correlation, not proof. It is the number the system exists
          to move, so it is reported rather than argued.
        </p>
      </Panel>
    </div>
  );
}

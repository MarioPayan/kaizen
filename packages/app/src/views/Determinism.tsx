import { conversionCandidates, incidentsByRung, RUNGS, type State } from '@kaizen/data';
import { Chip, Empty, Meter, Panel, Tooltip } from '@kaizen/ui';

const RUNG_COLOR = ['text-accent', 'text-accent', 'text-brass', 'text-rust'] as const;
const RUNG_TONE = ['accent', 'accent', 'brass', 'rust'] as const;

export default function Determinism({ state }: { state: State }) {
  const byRung = incidentsByRung(state);
  const maxRung = Math.max(1, ...byRung);
  const candidates = conversionCandidates(state);
  const anyTriaged = byRung.some((v) => v > 0);

  return (
    <div className="flex flex-col gap-8">
      <section>
        <p className="mb-3 max-w-2xl text-sm text-ink-2">
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
      </section>

      <section>
        <h3 className="mb-3 font-mono text-sm font-bold">Incidents by target rung</h3>
        {anyTriaged ? (
          <div className="flex flex-col gap-2">
            {RUNGS.map((r) => (
              <Meter
                key={r.n}
                label={`rung ${r.n} — ${r.title.toLowerCase()}`}
                value={byRung[r.n] ?? 0}
                max={maxRung}
                tone={RUNG_TONE[r.n]}
              />
            ))}
          </div>
        ) : (
          <Empty>
            Nothing is triaged yet, so no rung has been assigned. Run{' '}
            <code className="font-mono">/kaizen:triage</code>.
          </Empty>
        )}
      </section>

      <section>
        <h3 className="mb-1 font-mono text-sm font-bold">Conversion candidates</h3>
        <p className="mb-3 max-w-2xl text-sm text-ink-2">
          Clusters whose fix belongs in a script. The number is how many recorded incidents stop being
          possible once it exists.
        </p>
        {candidates.length === 0 ? (
          <Empty>None identified yet — triage assigns the rung that puts them here.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {candidates.map((c) => (
              <Meter
                key={c.id}
                label={c.label}
                caption={`${c.id} — ${c.label}`}
                value={c.incidents}
                max={candidates[0]?.incidents ?? 1}
              />
            ))}
          </div>
        )}
      </section>

      <Panel>
        <h3 className="font-mono text-sm font-bold">Where prose concentrates</h3>
        <p className="mt-1 text-sm text-ink-2">
          {state.metrics.proseLines.toLocaleString()} lines of instruction across {state.skills.length} skills
          and modules, against {state.metrics.scriptCount} scripts. The ratio worth watching is{' '}
          <Tooltip content="Incidents divided by lines of prose, times 100. It should fall as fixes move down the ladder.">
            failures per 100 lines
          </Tooltip>{' '}
          — currently <span className="font-mono font-bold">{state.metrics.incidentsPer100Lines}</span>.
        </p>
        <p className="mt-2 text-xs text-ink-3">
          <Chip tone="brass">note</Chip> With project scanning on, this counts skills that have never filed
          anything, which dilutes the ratio. It is the number the system exists to move, so it is reported
          rather than argued.
        </p>
      </Panel>
    </div>
  );
}

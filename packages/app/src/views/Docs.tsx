import { Link } from 'react-router-dom';
import { LIFECYCLE, RUNGS, useConfig } from '@kaizen/data';
import { Chip, Note, Panel } from '@kaizen/ui';
import {
  EFFORT_HELP,
  OBJECTIVE_HELP,
  SCORE_HELP,
  SEVERITY_HELP,
  TYPE_HELP,
  objectiveTone,
  severityTone,
  statusTone,
  typeTone,
} from '../lib/taxonomy';

/**
 * What the queue will put in front of you, and what stops a bad fix landing.
 *
 * Flat sections, no table of contents, no anchor routing and no search box. This
 * page is read once and then Ctrl-F'd; anything collapsed or paginated is
 * documentation that does not get found.
 *
 * Every sentence comes from the same constant the chip popovers read, so the
 * explanation on a row and the explanation here cannot disagree.
 */

function Terms({
  title,
  intro,
  entries,
  tone,
}: {
  title: string;
  intro?: React.ReactNode;
  entries: [string, string][];
  tone?: (value: string) => Parameters<typeof Chip>[0]['tone'] | 'blank';
}) {
  return (
    <section>
      <h3 className="font-mono text-sm font-bold">{title}</h3>
      {intro && <p className="mt-1 max-w-2xl text-sm text-ink-2">{intro}</p>}
      <dl className="mt-3 flex flex-col gap-px border border-line bg-line">
        {entries.map(([term, meaning]) => {
          const t = tone?.(term);
          return (
            <div key={term} className="grid gap-1 bg-surface px-4 py-2.5 sm:grid-cols-[9rem_1fr] sm:gap-4">
              <dt>
                <Chip tone={t && t !== 'blank' ? t : 'neutral'}>{term}</Chip>
              </dt>
              <dd className="text-sm text-ink-2">{meaning}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/**
 * The pipeline, drawn from the spec rather than described next to it.
 *
 * Nothing here is written twice: the phases, who runs each, what each must
 * produce and where it comes to rest are all fields of `lifecycle.json`. The
 * TUI draws the same six from the same file, so the two cannot disagree.
 */
function Lifecycle() {
  return (
    <section>
      <h3 className="font-mono text-sm font-bold">The lifecycle</h3>
      <p className="mt-1 max-w-2xl text-sm text-ink-2">
        A suggestion moves through {LIFECYCLE.phases.length} phases and rests in exactly one status between
        each, so “where is this” always has one answer. Only one phase asks you anything.
      </p>
      <ol className="mt-3 flex flex-col gap-px border border-line bg-line">
        {LIFECYCLE.phases.map((p, i) => (
          <li key={p.id} className="grid grid-cols-[2rem_1fr] gap-4 bg-surface px-4 py-3">
            <span className="font-mono text-xl leading-none font-bold text-ink-3">{i + 1}</span>
            <div>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-sm font-bold">{p.title}</span>
                <span className="text-xs text-ink-3">{p.actor}</span>
                {p.attended && <Chip tone="brass">needs you</Chip>}
              </div>
              <p className="mt-1 text-[0.83rem] text-ink-2">{p.summary}</p>
              <div className="mt-1.5 flex flex-wrap items-baseline gap-2 text-xs text-ink-3">
                <span>comes to rest at</span>
                <Chip tone={statusTone(p.produces)}>{p.produces}</Chip>
                {p.requires.length > 0 && <span>needs {p.requires.join(', ')}</span>}
              </div>
            </div>
          </li>
        ))}
      </ol>

      <h4 className="mt-4 font-mono text-xs font-bold">What can follow what</h4>
      <p className="mt-1 max-w-2xl text-sm text-ink-2">
        These are data, not a convention. <code className="font-mono text-xs">approved</code> is reachable
        only from <code className="font-mono text-xs">planned</code>, which is what makes an approval with no
        plan behind it impossible to write down.
      </p>
      <dl className="mt-2 flex flex-col gap-px border border-line bg-line">
        {LIFECYCLE.statuses.map((s) => (
          <div key={s.id} className="flex flex-wrap items-baseline gap-2 bg-surface px-4 py-2">
            <dt className="w-24">
              <Chip tone={statusTone(s.id)}>{s.id}</Chip>
            </dt>
            <dd className="flex flex-wrap items-baseline gap-2 text-xs text-ink-3">
              {s.next.length === 0 ? (
                <span>terminal — nothing follows</span>
              ) : (
                s.next.map((n) => (
                  <span key={n} className="font-mono">
                    → {n}
                  </span>
                ))
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** A guard, and whether it is switched on right now. */
function Guard({ name, on, children }: { name: string; on?: boolean; children: React.ReactNode }) {
  return (
    <li className="border-l-2 border-line pl-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-xs font-bold">{name}</span>
        {on !== undefined && (
          <Chip tone={on ? 'accent' : 'rust'}>{on ? 'on' : 'off — you turned this off'}</Chip>
        )}
      </div>
      <p className="mt-1 text-sm text-ink-2">{children}</p>
    </li>
  );
}

export default function Docs() {
  // The three configurable guards report their live setting. Documentation that
  // describes a guard you have since switched off is worse than none.
  const { data } = useConfig();
  const cfg = data?.config;

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <section>
        <h2 className="font-mono text-base font-bold">What kind of suggestions will I get</h2>
        <p className="mt-1.5 text-sm text-ink-2">
          Skills file a suggestion when a run went worse than it needed to — an ambiguous step, missing
          context, an edge case, or a stretch of pure mechanics that should have been a script. Every filed
          suggestion carries the six labels below. Until a{' '}
          <code className="font-mono text-xs">/kaizen:triage</code> pass assigns them the suggestion is
          untriaged, which is a fact worth seeing rather than a gap worth guessing at — untriaged items are
          never hidden by your filters, whatever those filters say.
        </p>
      </section>

      <Lifecycle />

      <Terms
        title="Change type"
        intro="What kind of change the fix is. One per suggestion."
        entries={Object.entries(TYPE_HELP)}
        tone={(v) => typeTone(v as Parameters<typeof typeTone>[0])}
      />

      <Terms
        title="Objective"
        intro="Why it is worth doing."
        entries={Object.entries(OBJECTIVE_HELP)}
        tone={(v) => objectiveTone(v as Parameters<typeof objectiveTone>[0])}
      />

      <Terms
        title="Severity"
        intro="How bad the run actually was. Bias low — high should mean something broke."
        entries={Object.entries(SEVERITY_HELP)}
        tone={(v) => severityTone(v as Parameters<typeof severityTone>[0])}
      />

      <Terms
        title="Effort"
        intro="A claim about cost, not about importance. It divides the score."
        entries={Object.entries(EFFORT_HELP)}
      />

      <Terms
        title="Status"
        intro={
          <>
            Where a suggestion is in your queue. Files written before the lifecycle spec carry the older names
            — <code className="font-mono text-xs">new</code> and{' '}
            <code className="font-mono text-xs">proposed</code> — and are read as{' '}
            <code className="font-mono text-xs">recorded</code> and{' '}
            <code className="font-mono text-xs">planned</code>.
          </>
        }
        entries={LIFECYCLE.statuses.map((s) => [s.id, s.help])}
        tone={statusTone}
      />

      <section>
        <h3 className="font-mono text-sm font-bold">How it is ranked</h3>
        <p className="mt-1 max-w-2xl text-sm text-ink-2">
          <span className="font-mono text-xs">{SCORE_HELP}</span> Recurrence is the honest signal — a
          suggestion filed six times is six real incidents, not one loud opinion.
        </p>
      </section>

      <section>
        <h3 className="font-mono text-sm font-bold">The determinism ladder</h3>
        <p className="mt-1 max-w-2xl text-sm text-ink-2">
          Every fix is placed on a rung, and may not be applied higher than necessary. A proposal at rung 2 or
          3 has to say why the rung below it does not work. This is the bias the whole tool exists to express:
          a failure that keeps happening is not a reminder problem.
        </p>
        <div className="mt-3 flex flex-col gap-px border border-line bg-line">
          {RUNGS.map((r) => (
            <div
              key={r.n}
              className="grid grid-cols-[2rem_1fr_auto] items-baseline gap-4 bg-surface px-4 py-3"
            >
              <span
                className={`font-mono text-xl leading-none font-bold ${
                  r.n === 3 ? 'text-rust' : r.n === 2 ? 'text-brass' : 'text-accent'
                }`}
              >
                {r.n}
              </span>
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
        <h3 className="font-mono text-sm font-bold">How bad changes are stopped from landing</h3>
        <p className="mt-1 mb-3 max-w-2xl text-sm text-ink-2">
          Approving something here eventually runs <code className="font-mono text-xs">git apply</code>{' '}
          against a real repository. These are the checks between the two, and each is code, not a convention.
        </p>
        <ul className="flex flex-col gap-3">
          <Guard name="read-only targets">
            A target is writable only if it says so explicitly. Anything unset, and every skill found by
            project scanning, is read-only — applying against one is refused with a 403 before any git command
            runs.
          </Guard>
          <Guard name="nothing applies by itself" on={(cfg?.autoApply.length ?? 0) === 0}>
            {cfg?.autoApply.length
              ? `Currently allowed without asking you: ${cfg.autoApply.join(', ')}.`
              : 'No rule permits a change to land without you approving it. This ships empty and stays empty unless you change it in Settings.'}
          </Guard>
          <Guard name="clean tree" on={cfg?.applyGuards.requireCleanTree}>
            {cfg?.applyGuards.requireCleanTree
              ? 'Applying over uncommitted work is refused, and the refusal names the dirty files. This is what keeps git revert a clean undo.'
              : 'Currently not required, so a fix can land on top of uncommitted work — which makes reverting it messier than one command.'}
          </Guard>
          <Guard name="the patch has to apply" on={cfg?.applyGuards.requireDiffApplies}>
            {cfg?.applyGuards.requireDiffApplies
              ? 'git apply --check must pass first; a stale patch fails with git’s own message rather than half-landing.'
              : 'Currently not required. A patch written against an older version of the file may apply badly.'}
          </Guard>
          <Guard name="applied cannot be faked">
            The API refuses to set <code className="font-mono text-xs">applied</code>. Only the server writes
            it, and only after git returned a commit sha. Nothing on this page can claim work landed that did
            not.
          </Guard>
          <Guard name="every apply is one commit">
            Each carries a <code className="font-mono text-xs">Kaizen-Suggestion:</code> trailer, so{' '}
            <code className="font-mono text-xs">git log --grep=Kaizen-Suggestion</code> is the ledger and{' '}
            <code className="font-mono text-xs">git revert &lt;sha&gt;</code> is the undo.
          </Guard>
          <Guard name="loopback only">
            The server refuses to bind anything but 127.0.0.1. These routes write files and shell out to git;
            that binding is the entire security boundary.
          </Guard>
          <Guard name="paths stay inside their target">
            Every caller-supplied path is resolved through symlinks and asserted inside a configured target
            before it is touched.
          </Guard>
        </ul>
      </section>

      <Panel>
        <h3 className="mb-1 font-mono text-sm font-bold">The app is not exempt</h3>
        <p className="text-sm text-ink-2">
          Kaizen runs the same loop against itself and files into{' '}
          <code className="font-mono text-xs">kaizen-app</code> through the same pipeline as any skill — no
          separate machinery, no exemption.{' '}
          <Link
            to="/queue?skill=kaizen-app&all=1"
            className="font-mono text-xs text-accent-ink underline underline-offset-2"
          >
            See what it has filed against itself
          </Link>
          .
        </p>
      </Panel>

      <Note tone="accent">
        Suggestions that share one fix are grouped into a cluster, and approving the cluster approves every
        member as one decision. A cluster past the promotion threshold has already proved that prose failed
        repeatedly there, so its fix must land as a hook or a script.
      </Note>
    </div>
  );
}

import { useState } from 'react';
import { useConfig, useSaveConfig } from '../api';
import type { Config } from '../types';
import { Button, Chip, ErrorNote, Panel } from '../components/ui';

/**
 * A typed form over the config file, validated server-side before it lands.
 *
 * The config is the contract the skill actually reads at runtime, not a mirror of
 * settings kept somewhere else — so a change here changes behaviour, and a bad
 * value fails loudly instead of being silently ignored on the next run.
 */

const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5 — deepest' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 — balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — fastest' },
];

const STAGES: { key: keyof Config['models']; label: string; hint: string }[] = [
  { key: 'triage', label: 'triage', hint: 'assigns taxonomy and rung — judgement-heavy' },
  { key: 'proposal', label: 'proposals', hint: 'writes the actual patches' },
  { key: 'validate', label: 'validate', hint: 'mechanical checks; cheap is right here' },
  { key: 'appReview', label: 'app review', hint: 'reviews this app against its own rubric' },
];

const AUTO_APPLY = [
  { value: '', label: 'nothing — every change waits for you' },
  { value: 'content:S,hygiene:S', label: 'typos and stale paths only (content + hygiene, effort S)' },
];

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid items-baseline gap-1 py-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:gap-4">
      <div>
        <span className="font-mono text-xs text-ink-2">{label}</span>
        {hint && <span className="mt-0.5 block text-[0.7rem] text-ink-3">{hint}</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}

const input = 'w-full max-w-sm border border-line bg-surface px-2 py-1 font-mono text-xs text-ink';

export default function Settings() {
  const { data, isLoading } = useConfig();
  const save = useSaveConfig();
  // Only local edits live in state. The server value is read straight from the
  // query, so there is nothing to keep in sync and no effect to get wrong.
  const [edited, setEdited] = useState<Config | null>(null);
  const [raw, setRaw] = useState(false);
  const [rawEdit, setRawEdit] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);

  if (isLoading || !data?.config) return <p className="text-sm text-ink-3">loading…</p>;

  const draft = edited ?? data.config;
  const rawText = rawEdit ?? JSON.stringify(draft, null, 2);
  const patch = (next: Partial<Config>) => setEdited({ ...draft, ...next });
  const dirty = edited !== null && JSON.stringify(edited) !== JSON.stringify(data.config);

  const commit = () => {
    if (raw) {
      try {
        const parsed = JSON.parse(rawText) as Config;
        setRawError(null);
        setEdited(parsed);
        save.mutate(parsed);
      } catch (e) {
        setRawError((e as Error).message);
      }
      return;
    }
    save.mutate(draft);
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-2">
          Stored in <code className="font-mono text-xs">~/.claude/kaizen/config.json</code>.
        </p>
        <Button tone="ghost" onClick={() => setRaw(!raw)}>
          {raw ? 'form' : 'raw JSON'}
        </Button>
      </div>

      {raw ? (
        <>
          <textarea
            value={rawText}
            onChange={(e) => setRawEdit(e.target.value)}
            spellCheck={false}
            rows={26}
            className="w-full border border-line bg-sunk p-3 font-mono text-xs text-ink"
          />
          {rawError && (
            <p className="border-l-2 border-rust bg-rust-soft px-3 py-2 font-mono text-xs text-rust">
              {rawError}
            </p>
          )}
        </>
      ) : (
        <>
          <Panel>
            <h3 className="mb-1 font-mono text-sm font-bold">Targets</h3>
            <p className="mb-2 text-xs text-ink-3">
              Read in place. Nothing is copied, so a skill edited elsewhere is current here.
            </p>
            {draft.targets.length === 0 ? (
              <p className="text-xs text-ink-3">
                None configured — run <code className="font-mono">/kaizen-init</code>.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {draft.targets.map((t) => (
                  <li key={t.name} className="flex flex-wrap items-center gap-2">
                    <Chip tone={t.writable ? 'accent' : 'neutral'}>
                      {t.writable ? 'writable' : 'read-only'}
                    </Chip>
                    <span className="font-mono text-xs">{t.name}</span>
                    <span className="font-mono text-[0.68rem] break-all text-ink-3">{t.skills}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 border-t border-line-soft pt-2">
              <Row label="scan projects" hint="find .claude/skills inside repositories">
                <select
                  aria-label="scan projects"
                  value={draft.scan.enabled ? 'on' : 'off'}
                  onChange={(e) => patch({ scan: { ...draft.scan, enabled: e.target.value === 'on' } })}
                  className={input}
                >
                  <option value="off">off</option>
                  <option value="on">on — read-only</option>
                </select>
              </Row>
              {draft.scan.enabled && (
                <Row label="scan roots" hint="comma separated; bounded by depth">
                  <input
                    aria-label="scan roots"
                    className={input}
                    value={draft.scan.roots.join(', ')}
                    onChange={(e) =>
                      patch({
                        scan: {
                          ...draft.scan,
                          roots: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        },
                      })
                    }
                  />
                </Row>
              )}
            </div>
          </Panel>

          <Panel>
            <h3 className="mb-1 font-mono text-sm font-bold">Cadence</h3>
            <Row label="weekly pass" hint="when a full triage runs">
              <input
                aria-label="weekly pass"
                className={input}
                value={draft.cadence.weekly}
                onChange={(e) => patch({ cadence: { ...draft.cadence, weekly: e.target.value } })}
              />
            </Row>
            <Row label="session line" hint="one line at session start; costs nothing">
              <select
                aria-label="session line"
                className={input}
                value={draft.cadence.sessionHook ? 'on' : 'off'}
                onChange={(e) =>
                  patch({ cadence: { ...draft.cadence, sessionHook: e.target.value === 'on' } })
                }
              >
                <option value="on">on</option>
                <option value="off">off</option>
              </select>
            </Row>
          </Panel>

          <Panel>
            <h3 className="mb-1 font-mono text-sm font-bold">Models</h3>
            <p className="mb-2 text-xs text-ink-3">
              Which model each stage uses. Mechanical stages do not need the deepest one.
            </p>
            {STAGES.map((s) => (
              <Row key={s.key} label={s.label} hint={s.hint}>
                <select
                  aria-label={s.label}
                  className={input}
                  value={draft.models[s.key]}
                  onChange={(e) => patch({ models: { ...draft.models, [s.key]: e.target.value } })}
                >
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Row>
            ))}
          </Panel>

          <Panel>
            <h3 className="mb-1 font-mono text-sm font-bold">Guards</h3>
            <Row label="auto-apply" hint="what may land without you approving it">
              <select
                aria-label="auto-apply"
                className={input}
                value={draft.autoApply.join(',')}
                onChange={(e) => patch({ autoApply: e.target.value ? e.target.value.split(',') : [] })}
              >
                {AUTO_APPLY.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="clean tree" hint="refuse to apply over uncommitted work">
              <select
                aria-label="clean tree"
                className={input}
                value={draft.applyGuards.requireCleanTree ? 'on' : 'off'}
                onChange={(e) =>
                  patch({
                    applyGuards: {
                      ...draft.applyGuards,
                      requireCleanTree: e.target.value === 'on',
                    },
                  })
                }
              >
                <option value="on">required</option>
                <option value="off">not required</option>
              </select>
            </Row>
            <Row label="cluster promotion" hint="above this, a fix must be a hook or a script">
              <span className="flex items-center gap-2">
                <input
                  aria-label="promotion members"
                  type="number"
                  min={2}
                  className="w-20 border border-line bg-surface px-2 py-1 font-mono text-xs text-ink"
                  value={draft.clusterPromotion.members}
                  onChange={(e) =>
                    patch({
                      clusterPromotion: {
                        ...draft.clusterPromotion,
                        members: Number(e.target.value),
                      },
                    })
                  }
                />
                <span className="text-xs text-ink-3">members, or</span>
                <input
                  aria-label="promotion incidents"
                  type="number"
                  min={2}
                  className="w-20 border border-line bg-surface px-2 py-1 font-mono text-xs text-ink"
                  value={draft.clusterPromotion.incidents}
                  onChange={(e) =>
                    patch({
                      clusterPromotion: {
                        ...draft.clusterPromotion,
                        incidents: Number(e.target.value),
                      },
                    })
                  }
                />
                <span className="text-xs text-ink-3">incidents</span>
              </span>
            </Row>
          </Panel>
        </>
      )}

      <ErrorNote error={save.error} />

      <div className="flex items-center gap-3">
        <Button onClick={commit} disabled={save.isPending || (!dirty && !raw)}>
          {save.isPending ? 'saving…' : 'Save'}
        </Button>
        {save.isSuccess && !dirty && <Chip tone="accent">saved</Chip>}
        {dirty && <span className="font-mono text-xs text-brass">unsaved changes</span>}
      </div>
    </div>
  );
}

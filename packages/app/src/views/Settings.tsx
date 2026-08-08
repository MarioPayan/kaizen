import { useState } from 'react';
import { useConfig, useSaveConfig, type Config } from '@kaizen/data';
import { Button, Chip, ErrorNote, Note, Panel, Select, useToast } from '@kaizen/ui';

/**
 * A typed form over the config file, validated server-side before it lands.
 *
 * The config is the contract the skill reads at runtime, not a mirror of settings
 * held elsewhere — a change here changes behaviour, and a bad value is refused
 * loudly rather than ignored on the next run.
 */

const MODELS = [
  { value: 'claude-opus-5', label: 'Opus 5 — deepest' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5 — balanced' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — fastest' },
];

const STAGES: { key: keyof Config['models']; label: string; hint: string }[] = [
  { key: 'triage', label: 'triage', hint: 'assigns taxonomy and rung — judgement-heavy' },
  { key: 'proposal', label: 'proposals', hint: 'writes the actual patches' },
  { key: 'validate', label: 'validate', hint: 'mechanical checks; cheap is right here' },
  { key: 'appReview', label: 'app review', hint: 'reviews this app against its own rubric' },
];

const AUTO_APPLY = [
  { value: '', label: 'nothing — every change waits for you' },
  { value: 'content:S,hygiene:S', label: 'typos and stale paths only' },
];

const ONOFF = [
  { value: 'on', label: 'on' },
  { value: 'off', label: 'off' },
];

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid items-baseline gap-1 border-b border-line-soft py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-4">
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
  const toast = useToast();
  // Only local edits live in state; the server value is read from the query, so
  // there is nothing to keep in sync and no effect to get wrong.
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
    const done = { onSuccess: () => toast.ok('Settings saved') };
    if (!raw) return save.mutate(draft, done);
    try {
      const parsed = JSON.parse(rawText) as Config;
      setRawError(null);
      setEdited(parsed);
      save.mutate(parsed, done);
    } catch (e) {
      setRawError((e as Error).message);
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-ink-2">
          Stored in <code className="font-mono text-xs">~/.claude/kaizen/config.json</code>.
        </p>
        <Button variant="ghost" onClick={() => setRaw(!raw)}>
          {raw ? 'form' : 'raw JSON'}
        </Button>
      </div>

      {raw ? (
        <>
          <textarea
            aria-label="raw config"
            value={rawText}
            onChange={(e) => setRawEdit(e.target.value)}
            spellCheck={false}
            rows={26}
            className="w-full border border-line bg-sunk p-3 font-mono text-xs text-ink"
          />
          {rawError && <ErrorNote error={new Error(rawError)} />}
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
                None configured — run <code className="font-mono">/kaizen:init</code>.
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
            <div className="mt-3 border-t border-line-soft">
              <Row label="scan projects" hint="find .claude/skills inside repositories">
                <Select
                  label="scan projects"
                  value={draft.scan.enabled ? 'on' : 'off'}
                  onValueChange={(v) => patch({ scan: { ...draft.scan, enabled: v === 'on' } })}
                  options={[
                    { value: 'off', label: 'off' },
                    { value: 'on', label: 'on — read-only' },
                  ]}
                />
              </Row>
              {draft.scan.enabled && (
                <Row label="scan roots" hint="comma separated; git worktrees are collapsed">
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
              <Select
                label="session line"
                value={draft.cadence.sessionHook ? 'on' : 'off'}
                onValueChange={(v) => patch({ cadence: { ...draft.cadence, sessionHook: v === 'on' } })}
                options={ONOFF}
              />
            </Row>
          </Panel>

          <Panel>
            <h3 className="mb-1 font-mono text-sm font-bold">Models</h3>
            <p className="mb-2 text-xs text-ink-3">
              Which model each stage uses. Mechanical stages do not need the deepest one.
            </p>
            {STAGES.map((s) => (
              <Row key={s.key} label={s.label} hint={s.hint}>
                <Select
                  label={s.label}
                  value={draft.models[s.key]}
                  onValueChange={(v) => patch({ models: { ...draft.models, [s.key]: v } })}
                  options={MODELS}
                />
              </Row>
            ))}
          </Panel>

          <Panel>
            <h3 className="mb-1 font-mono text-sm font-bold">Guards</h3>
            <Row label="auto-apply" hint="what may land without you approving it">
              <Select
                label="auto-apply"
                value={draft.autoApply.join(',')}
                onValueChange={(v) => patch({ autoApply: v ? v.split(',') : [] })}
                options={AUTO_APPLY}
              />
            </Row>
            <Row label="clean tree" hint="refuse to apply over uncommitted work">
              <Select
                label="clean tree"
                value={draft.applyGuards.requireCleanTree ? 'on' : 'off'}
                onValueChange={(v) =>
                  patch({
                    applyGuards: { ...draft.applyGuards, requireCleanTree: v === 'on' },
                  })
                }
                options={[
                  { value: 'on', label: 'required' },
                  { value: 'off', label: 'not required' },
                ]}
              />
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
                      clusterPromotion: { ...draft.clusterPromotion, members: Number(e.target.value) },
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
                      clusterPromotion: { ...draft.clusterPromotion, incidents: Number(e.target.value) },
                    })
                  }
                />
                <span className="text-xs text-ink-3">incidents</span>
              </span>
            </Row>
          </Panel>

          {data.errors.length > 0 && <Note tone="rust">{data.errors.join('; ')}</Note>}
        </>
      )}

      <ErrorNote error={save.error} />

      <div className="flex items-center gap-3">
        <Button onClick={commit} disabled={save.isPending || (!dirty && !raw)}>
          {save.isPending ? 'saving…' : 'Save'}
        </Button>
        {dirty && <span className="font-mono text-xs text-brass">unsaved changes</span>}
      </div>
    </div>
  );
}

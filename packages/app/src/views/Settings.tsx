import { useState } from 'react';
import { useConfig, useSaveConfig, type Config } from '@kaizen/data';
import {
  Button,
  CheckboxGroup,
  Chip,
  ErrorNote,
  Field,
  Fieldset,
  Form,
  Input,
  Note,
  NumberField,
  SegmentedControl,
  Select,
  Switch,
  TextField,
  useToast,
} from '@kaizen/ui';
import { OBJECTIVE_HELP, SEVERITY_HELP, TYPE_HELP } from '../lib/taxonomy';

/**
 * A typed form over the config file, validated server-side before it lands.
 *
 * The config is the contract the skill reads at runtime, not a mirror of settings
 * held elsewhere — a change here changes behaviour, and a bad value is refused
 * loudly rather than ignored on the next run. Every control is named for the
 * config path it writes, which is also the key the server's rejection arrives
 * under, so a refusal lands under the control that caused it.
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
];

const AUTO_APPLY = [
  { value: '', label: 'nothing — every change waits for you' },
  { value: 'content:S,hygiene:S', label: 'typos and stale paths only' },
];

const TYPE_OPTIONS = Object.entries(TYPE_HELP).map(([value, hint]) => ({ value, label: value, hint }));
const OBJECTIVE_OPTIONS = Object.entries(OBJECTIVE_HELP).map(([value, hint]) => ({
  value,
  label: value,
  hint,
}));
const SEVERITY_OPTIONS = Object.keys(SEVERITY_HELP)
  .reverse()
  .map((value) => ({ value, label: value }));

/**
 * The server prefixes every validation message with the config path it failed
 * on. Splitting on that prefix is all it takes to put each message under its own
 * control instead of in one pile at the bottom.
 */
function byField(errors: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const message of errors) {
    const key = (message.split(' ')[0] ?? '').replace(/[:,]$/, '');
    out[key] = out[key] ? `${out[key]} ${message}` : message;
  }
  return out;
}

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
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  if (isLoading || !data?.config) return <p className="text-sm text-ink-3">loading…</p>;

  const draft = edited ?? data.config;
  const rawText = rawEdit ?? JSON.stringify(draft, null, 2);
  const patch = (next: Partial<Config>) => setEdited({ ...draft, ...next });
  const dirty = edited !== null && JSON.stringify(edited) !== JSON.stringify(data.config);

  const persist = (config: Config) =>
    save.mutate(config, {
      onSuccess: () => {
        setServerErrors({});
        toast.ok('Settings saved');
      },
      onError: (e) => setServerErrors(byField((e as Error & { fields?: string[] }).fields ?? [e.message])),
    });

  const commit = () => {
    if (!raw) return persist(draft);
    try {
      const parsed = JSON.parse(rawText) as Config;
      setRawError(null);
      setEdited(parsed);
      persist(parsed);
    } catch (e) {
      setRawError((e as Error).message);
    }
  };

  const roots = draft.scan.roots;
  const setRoots = (next: string[]) => patch({ scan: { ...draft.scan, roots: next } });

  return (
    <Form
      errors={serverErrors}
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
      className="flex max-w-3xl flex-col gap-4"
    >
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
          <Fieldset
            legend="Targets"
            hint="Read in place. Nothing is copied, so a skill edited elsewhere is current here."
          >
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
              <Field name="scan" label="scan projects" hint="find .claude/skills inside repositories">
                <Switch
                  label="scan projects"
                  checked={draft.scan.enabled}
                  onCheckedChange={(on) => patch({ scan: { ...draft.scan, enabled: on } })}
                />
              </Field>
              {draft.scan.enabled && (
                <Field
                  name="scan.roots"
                  label="scan roots"
                  hint="one path per row; git worktrees are collapsed"
                >
                  {/*
                    A list, not a comma-joined string. The single text box this
                    replaces destroyed any path containing a comma and gave no
                    way to tell which of five roots was the broken one.
                  */}
                  <ul className="flex flex-col gap-1.5">
                    {roots.map((root, i) => (
                      <li key={i} className="flex items-center gap-1.5">
                        <Input
                          label={`scan root ${i + 1}`}
                          value={root}
                          placeholder="/absolute/path"
                          onValueChange={(v) => setRoots(roots.map((r, j) => (j === i ? v : r)))}
                        />
                        <Button
                          variant="ghost"
                          title={`Remove ${root || 'this root'}`}
                          onClick={() => setRoots(roots.filter((_, j) => j !== i))}
                        >
                          remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <Button variant="ghost" onClick={() => setRoots([...roots, ''])}>
                    add root
                  </Button>
                </Field>
              )}
            </div>
          </Fieldset>

          <Fieldset
            legend="What you want to see"
            hint="Sets what the queue opens on and what the session line counts. Nothing is deleted — muted suggestions stay on disk and stay one click away. Untriaged items always show, whatever this says."
          >
            <Field name="surface.types" label="change types">
              <CheckboxGroup
                label="change types"
                allLabel="all types"
                value={draft.surface.types}
                onValueChange={(v) =>
                  patch({ surface: { ...draft.surface, types: v as Config['surface']['types'] } })
                }
                options={TYPE_OPTIONS}
              />
            </Field>
            <Field name="surface.objectives" label="objectives">
              <CheckboxGroup
                label="objectives"
                allLabel="all objectives"
                value={draft.surface.objectives}
                onValueChange={(v) =>
                  patch({
                    surface: { ...draft.surface, objectives: v as Config['surface']['objectives'] },
                  })
                }
                options={OBJECTIVE_OPTIONS}
              />
            </Field>
            <Field
              name="surface.minSeverity"
              label="at least"
              hint={SEVERITY_HELP[draft.surface.minSeverity]}
            >
              <SegmentedControl
                label="minimum severity"
                value={draft.surface.minSeverity}
                onValueChange={(v) =>
                  patch({
                    surface: { ...draft.surface, minSeverity: v as Config['surface']['minSeverity'] },
                  })
                }
                options={SEVERITY_OPTIONS}
              />
            </Field>
          </Fieldset>

          <Fieldset legend="Cadence">
            <TextField
              name="cadence.weekly"
              label="weekly pass"
              hint="when a full triage runs"
              value={draft.cadence.weekly}
              onValueChange={(v) => patch({ cadence: { ...draft.cadence, weekly: v } })}
            />
            <Field
              name="cadence.sessionHook"
              label="session line"
              hint="one line at session start; costs nothing"
            >
              <Switch
                label="session line"
                checked={draft.cadence.sessionHook}
                onCheckedChange={(on) => patch({ cadence: { ...draft.cadence, sessionHook: on } })}
              />
            </Field>
          </Fieldset>

          <Fieldset
            legend="Models"
            hint="Which model each stage uses. Mechanical stages do not need the deepest one."
          >
            {STAGES.map((s) => (
              <Field key={s.key} name={`models.${s.key}`} label={s.label} hint={s.hint}>
                <Select
                  label={s.label}
                  value={draft.models[s.key]}
                  onValueChange={(v) => patch({ models: { ...draft.models, [s.key]: v } })}
                  options={MODELS}
                />
              </Field>
            ))}
          </Fieldset>

          <Fieldset legend="Guards">
            <Field name="autoApply" label="auto-apply" hint="what may land without you approving it">
              <Select
                label="auto-apply"
                value={draft.autoApply.join(',')}
                onValueChange={(v) => patch({ autoApply: v ? v.split(',') : [] })}
                options={AUTO_APPLY}
              />
            </Field>
            <Field
              name="applyGuards"
              label="clean tree"
              hint="refuse to apply over uncommitted work, so git revert stays a clean undo"
            >
              <Switch
                label="clean tree"
                checked={draft.applyGuards.requireCleanTree}
                onCheckedChange={(on) =>
                  patch({ applyGuards: { ...draft.applyGuards, requireCleanTree: on } })
                }
              />
            </Field>
            <Field
              name="clusterPromotion"
              label="cluster promotion"
              hint="above this, a fix must be a hook or a script"
            >
              <span className="flex flex-wrap items-center gap-2">
                <NumberField
                  label="promotion members"
                  min={2}
                  value={draft.clusterPromotion.members}
                  onValueChange={(v) =>
                    patch({ clusterPromotion: { ...draft.clusterPromotion, members: v ?? 2 } })
                  }
                />
                <span className="text-xs text-ink-3">members, or</span>
                <NumberField
                  label="promotion incidents"
                  min={2}
                  value={draft.clusterPromotion.incidents}
                  onValueChange={(v) =>
                    patch({ clusterPromotion: { ...draft.clusterPromotion, incidents: v ?? 2 } })
                  }
                />
                <span className="text-xs text-ink-3">incidents</span>
              </span>
            </Field>
          </Fieldset>

          {data.errors.length > 0 && <Note tone="rust">{data.errors.join('; ')}</Note>}
        </>
      )}

      <ErrorNote error={save.error} />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending || (!dirty && !raw)}>
          {save.isPending ? 'saving…' : 'Save'}
        </Button>
        {dirty && <span className="font-mono text-xs text-brass">unsaved changes</span>}
      </div>
    </Form>
  );
}

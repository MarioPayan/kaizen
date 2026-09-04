/**
 * Kaizen applying its own rubric to itself.
 *
 * Step 8 of the skill used to be a prose checklist — "has any view gone
 * unopened", "is any number not traceable to a file". Every item on it needed a
 * human to remember to look, and across the project's life the answer was found
 * by hand each time or not at all. That is rung 3: the exact place this tool
 * argues failures come from.
 *
 * So the self-review is a script. Each check below fired on a real defect that
 * was discovered by hand first — a config key nothing read, a decision with no
 * patch behind it, a capture format whose most important field was written zero
 * times in sixty-six attempts. Finding those once is luck. A check that finds
 * them every run is the improvement.
 *
 * A finding is shaped exactly like a suggestion, so `--file` can drop it into
 * the same queue as everything else and it competes on the same score.
 */
import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultConfig } from './config.mjs';
import { resolveTargets } from './config.mjs';
import { inPatchWindow, patchWindow, isTerminal, hasLanded } from './lifecycle.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The receipt under `## Evidence`, as a bullet list. Every check already
 * computes it — the sibling slugs, the `git apply` stderr, the key path — and
 * used to fold it into the context prose, so doctor's own filings failed the
 * capture spec kaizen enforces on everyone else, on the day they were written.
 */
const bullets = (items, cap = 10) =>
  [
    ...items.slice(0, cap).map((x) => `- ${x}`),
    ...(items.length > cap ? [`- +${items.length - cap} more`] : []),
  ].join('\n');

/** Every file we are willing to grep, bounded and deterministic. */
function sourceFiles(root, exts = ['.mjs', '.ts', '.tsx', '.md', '.json', '.sh']) {
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage']);
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name) || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (exts.some((x) => e.name.endsWith(x))) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

const read = (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

/** Leaf paths of the default config, as the names a consumer would type. */
function configLeaves(obj, prefix = []) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...configLeaves(v, [...prefix, k]));
    else out.push({ path: [...prefix, k].join('.'), key: k });
  }
  return out;
}

/* ------------------------------------------------------------------ checks -- */

/**
 * A setting the UI offers and nothing reads is worse than a missing setting:
 * it is a promise the tool does not keep. `cadence.sessionHook` was toggleable
 * for the life of the project and wired to nothing.
 */
function deadConfigKeys() {
  // Where a key is merely declared, not consumed.
  const DECLARERS = ['core/src/config.mjs', 'data/src/types.ts', 'app/src/views/Settings.tsx'];
  const files = sourceFiles(REPO).filter((f) => !f.includes(`${'tests'}/`));
  const corpus = files
    .filter((f) => !DECLARERS.some((d) => f.replace(/\\/g, '/').includes(d)))
    .map((f) => ({ f, text: read(f) }));

  const findings = [];
  for (const { path, key } of configLeaves(defaultConfig())) {
    if (key === 'version') continue;
    const readers = corpus.filter(({ text }) => text.includes(key));
    if (readers.length === 0) {
      findings.push({
        slug: `config-key-${path.replace(/\./g, '-')}-has-no-reader`,
        severity: 'medium',
        scope: 'packages/core/src/config.mjs',
        context: `\`${path}\` is in defaultConfig() and is validated and typed, but no file outside its declaration sites mentions \`${key}\`. Nothing reads it.`,
        evidence: bullets([
          `key: \`${path}\` (leaf \`${key}\`) in defaultConfig()`,
          `searched ${corpus.length} source files under the repo, excluding ${DECLARERS.join(', ')} and tests/: 0 mention it`,
        ]),
        suggestion: `Either wire \`${path}\` to the behaviour it names, or delete it. A setting the Settings page offers and no code consults is a promise the tool does not keep — the user changes it, nothing happens, and the next person to read the config assumes it works.`,
      });
    }
  }
  return findings;
}

/**
 * `approved` has to mean one thing. With no patch beside it, it means "you said
 * yes to something nobody has written", and /api/apply refuses with a 422.
 */
function decidedWithoutAPatch(state) {
  const stuck = state.suggestions.filter(
    (s) => inPatchWindow(s.status) && !existsSync(s.file.replace(/\.md$/, '.patch')),
  );
  if (stuck.length === 0) return [];
  return [
    {
      slug: 'decisions-with-no-proposal-behind-them',
      severity: stuck.length > 10 ? 'medium' : 'low',
      scope: 'skills/kaizen/SKILL.md',
      context: `${stuck.length} suggestion(s) sit at ${patchWindow().join(' or ')} with no .patch file beside them. /api/apply returns 422 for every one; the drain step has nothing to apply.`,
      evidence: bullets(stuck.map((s) => `${s.id}@${s.status} — no ${s.file.replace(/\.md$/, '.patch')}`)),
      suggestion: `Run a proposal pass (Step 5) for these, or split the status so the queue stops reporting them as ready. The count reads as progress and cannot move: ${stuck
        .slice(0, 5)
        .map((s) => s.slug)
        .join(', ')}${stuck.length > 5 ? `, +${stuck.length - 5} more` : ''}.`,
    },
  ];
}

/** A decision nobody acts on is friction in the approval flow, not a backlog. */
function staleDecisions(state, today, days = 14) {
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - days);
  const stale = state.suggestions.filter(
    (s) => inPatchWindow(s.status) && s.date && new Date(s.date) < cutoff,
  );
  if (stale.length === 0) return [];
  return [
    {
      slug: 'decisions-sitting-past-the-drain-window',
      severity: 'low',
      scope: 'skills/kaizen/SKILL.md',
      context: `${stale.length} suggestion(s) have been at ${patchWindow().join(' or ')} for more than ${days} days.`,
      evidence: bullets(
        stale.map(
          (s) => `${s.id}@${s.status}, filed ${s.date} (cutoff ${cutoff.toISOString().slice(0, 10)})`,
        ),
      ),
      suggestion:
        'The skill treats a long-sitting decision as evidence that the approval flow has friction, not that the work is unimportant. Find the step that is not happening — usually the proposal pass or a guard nobody can satisfy — and fix that rather than re-deciding.',
    },
  ];
}

/**
 * The capture format's most valuable field, measured. It went unwritten 66 times
 * out of 66 while the reflect module merely asked for it.
 */
function captureQuality(state, threshold = 0.1) {
  const total = state.suggestions.length;
  if (total === 0) return [];
  const missing = state.suggestions.filter((s) => !s.scope);
  const rate = missing.length / total;
  if (rate <= threshold) return [];
  return [
    {
      slug: 'suggestions-arriving-without-a-scope',
      severity: rate > 0.5 ? 'high' : 'medium',
      scope: 'skills/_lib/skill-reflect.md',
      context: `${missing.length} of ${total} suggestions (${Math.round(rate * 100)}%) have no \`scope\`. Clustering falls back to slug vocabulary alone when it is absent.`,
      evidence: bullets([
        `${missing.length}/${total} without scope, threshold ${threshold}`,
        ...missing.map((s) => s.id),
      ]),
      suggestion:
        'The capture step is dropping the field, not the triage step. Asking harder in prose has already been tried; the fix belongs where the file is written — a template that does not produce a file without it, or a filing command that refuses one.',
    },
  ];
}

/**
 * A script with no way to prove it works is not an improvement over the prose it
 * replaced. That is the skill's own rule for rung-1 fixes; this is it, enforced.
 */
function scriptsWithoutSelfCheck(config) {
  const roots = [join(REPO, 'scripts'), ...resolveTargets(config).map((t) => t.skills)];
  const findings = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const f of sourceFiles(root, ['.sh'])) {
      const text = read(f);
      if (text.includes('--self-check')) continue;
      // Only scripts a skill actually calls; loose helpers are not the target.
      if (!text.includes('#!/usr/bin/env bash') && !text.includes('#!/bin/bash')) continue;
      if (statSync(f).size < 400) continue;
      findings.push({
        slug: `script-without-a-self-check-${f.split('/').pop().replace(/\.sh$/, '')}`,
        severity: 'low',
        scope: relative(root, f) || f,
        context: `\`${f.replace(process.env.HOME ?? '~', '~')}\` is a shell script a skill depends on, and it has no \`--self-check\`.`,
        evidence: bullets([`${f}: bash shebang, ${statSync(f).size} bytes, no \`--self-check\` in the text`]),
        suggestion:
          'Add a `--self-check` that exercises the case the script exists to handle, offline. The rung-1 rule is that a script with no way to prove it works is not an improvement over the prose it replaced — and the cases worth checking are exactly the ones that produced the incidents.',
      });
    }
  }
  return findings;
}

/* ------------------------------------------------------------------- run -- */

/**
 * A proposal that no longer applies is worse than no proposal: it reads as ready
 * in the queue and 422s the moment anyone drains it. Patches rot whenever the
 * file underneath them moves, and nothing else notices.
 */
function patchesThatNoLongerApply(state, config) {
  const byTarget = new Map(resolveTargets(config).map((t) => [t.name, t]));
  const findings = [];
  for (const s of state.suggestions) {
    // A landed patch does not apply any more, and that is the success case. Only
    // a proposal still waiting to land can rot.
    if (isTerminal(s.status) || hasLanded(s.status)) continue;
    const patch = s.file.replace(/\.md$/, '.patch');
    if (!existsSync(patch)) continue;
    // A project skill files into the user feedback dir — that is where
    // skill-reflect puts it — but its patch is against the project, not the
    // target's skills tree. Check it where it applies, or the check calls every
    // project-skill proposal rotten. A known project that is gone is unknowable,
    // not rotten: skip rather than fall back to the wrong tree.
    const project = state.skills?.find((k) => k.name === s.skill)?.project;
    const cwd = project ?? byTarget.get(s.target)?.skills;
    if (!cwd || !existsSync(cwd)) continue;
    try {
      execFileSync('git', ['apply', '--check', patch], { cwd, stdio: 'pipe' });
    } catch (e) {
      const stderr = String(e.stderr ?? e.message).trim();
      findings.push({
        slug: `proposal-no-longer-applies-${s.slug}`.slice(0, 80),
        severity: 'medium',
        scope: s.scope || 'skills/kaizen/SKILL.md',
        context: `The patch beside \`${s.slug}\` no longer applies to ${cwd}: ${stderr.split('\n')[0]}`,
        evidence: bullets([`\`git -C ${cwd} apply --check ${patch}\` →`, ...stderr.split('\n').slice(0, 5)]),
        suggestion:
          'Re-generate the patch against the current file, or mark the suggestion superseded if the change landed another way. A proposal that cannot apply reports as ready and fails at drain time, which is the worst moment to discover it.',
      });
    }
  }
  return findings;
}

/**
 * Individually valid patches can still conflict when the drain lands them in
 * score order. Check that sequence in a disposable worktree before the first
 * commit turns the next proposal into a drain-time failure.
 */
function livePatchesConflict(state, config) {
  const writable = new Map(
    resolveTargets(config)
      .filter((t) => t.writable)
      .map((t) => [t.name, t]),
  );
  const byTarget = new Map();
  for (const s of state.suggestions) {
    if (isTerminal(s.status) || hasLanded(s.status) || !writable.has(s.target)) continue;
    const patch = s.file.replace(/\.md$/, '.patch');
    if (!existsSync(patch)) continue;
    if (!byTarget.has(s.target)) byTarget.set(s.target, []);
    byTarget.get(s.target).push({ ...s, patch });
  }

  const findings = [];
  for (const [targetName, patches] of byTarget) {
    if (patches.length < 2) continue;
    patches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id));

    const target = writable.get(targetName);
    let repo;
    let scratch;
    let worktree;
    const conflicts = [];
    try {
      repo = String(
        execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: target.skills, stdio: 'pipe' }),
      ).trim();
      scratch = mkdtempSync(join(tmpdir(), 'kaizen-doctor-patches-'));
      worktree = join(scratch, 'worktree');
      execFileSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: repo, stdio: 'pipe' });

      let previous = '';
      for (const current of patches) {
        try {
          execFileSync('git', ['apply', current.patch], { cwd: worktree, stdio: 'pipe' });
          previous = current.slug;
        } catch (e) {
          const stderr = String(e.stderr ?? e.message).trim();

          // Start the next comparison from the failed patch, not from a tree
          // still carrying the earlier side of the conflict.
          execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: worktree, stdio: 'pipe' });
          execFileSync('git', ['clean', '-fdq'], { cwd: worktree, stdio: 'pipe' });
          try {
            execFileSync('git', ['apply', current.patch], { cwd: worktree, stdio: 'pipe' });
            if (previous) conflicts.push({ before: previous, after: current, stderr });
            previous = current.slug;
          } catch {
            // patch-no-longer-applies reports a patch that also fails at HEAD.
            previous = '';
          }
        }
      }
    } catch {
      // A missing or unreadable target is already surfaced by scan warnings.
      continue;
    } finally {
      if (repo && worktree) {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repo, stdio: 'pipe' });
        } catch {
          // The scratch directory cleanup below is still safe and best-effort.
        }
      }
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }

    if (conflicts.length === 0) continue;
    findings.push({
      slug: `live-patches-conflict-${targetName}`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80),
      severity: 'medium',
      scope: conflicts[0].after.scope || 'skills/kaizen/SKILL.md',
      context: `${conflicts.length} live patch conflict(s) in writable target \`${targetName}\` when applied in score order. The later proposal(s) apply at HEAD but not after the proposal immediately before them.`,
      evidence: bullets(
        conflicts.flatMap(({ before, after, stderr }) => [
          `\`${after.slug}\` does not apply after \`${before}\``,
          ...stderr.split('\n').slice(0, 5),
        ]),
        Infinity,
      ),
      suggestion:
        'Re-generate or reorder the named patches so they apply in sequence before either is drained. Each patch is valid against HEAD by itself; the conflict only appears after an earlier live proposal is applied.',
    });
  }
  return findings;
}

/**
 * A shared-scope fix closes one member and orphans the rest.
 *
 * Found by hand, expensively. One artefact fixes every suggestion that names
 * the same scope file — but the drain marks only the suggestion named in the
 * commit, so the siblings sit at their old status forever. Two commits did
 * exactly this and left 27 suggestions reading as open work months after the
 * code that fixed them had shipped; the queue said 39 awaiting a decision when
 * the true number was 12.
 *
 * The signal is cheap: an unfinished suggestion whose scope already has a
 * finished one. That is not proof — a file can legitimately be fixed in
 * stages — so this reports rather than rewrites, and names the sha to check
 * against.
 */
/**
 * The day a finished sibling's fix landed: the commit date of its applied sha
 * when that resolves in the target, else the day it was filed (a superseded
 * sibling has no sha; its own date is the latest the fix can have landed).
 */
function fixedOn(s, byTarget) {
  const target = byTarget.get(s.target);
  if (s.appliedSha && target && existsSync(target.skills)) {
    try {
      const out = execFileSync('git', ['log', '-1', '--format=%cs', s.appliedSha], {
        cwd: target.skills,
        stdio: 'pipe',
      });
      const day = String(out).trim();
      if (day) return day;
    } catch {
      // Unresolvable sha: fall through to the filing date.
    }
  }
  return String(s.date ?? '').slice(0, 10);
}

function scopeFixOrphansSiblings(state, config = { targets: [] }) {
  const byTarget = new Map(resolveTargets(config).map((t) => [t.name, t]));
  const findings = [];
  const byScope = new Map();
  for (const s of state.suggestions) {
    if (!s.scope) continue;
    if (!byScope.has(s.scope)) byScope.set(s.scope, []);
    byScope.get(s.scope).push(s);
  }
  for (const [scope, members] of byScope) {
    if (members.length < 2) continue;
    const done = members.filter((s) => hasLanded(s.status) || s.status === 'superseded');
    // A member inside the patch window (planned, approved) is visibly
    // mid-pipeline — the queue already knows it is open, so "fixed and
    // unmarked" cannot apply to it. Only a pre-plan member can be an orphan —
    // and only one filed no later than the scope's last fix: a suggestion
    // written after the commit cannot have been fixed by it. Three false alarms
    // in one pass were exactly that, each costing a confirm-and-reject cycle.
    const lastFix =
      done
        .map((s) => fixedOn(s, byTarget))
        .filter(Boolean)
        .sort()
        .at(-1) ?? '';
    const openOnes = members.filter(
      (s) =>
        !isTerminal(s.status) &&
        !hasLanded(s.status) &&
        !inPatchWindow(s.status) &&
        !(lastFix && String(s.date ?? '').slice(0, 10) > lastFix),
    );
    if (done.length === 0 || openOnes.length === 0) continue;

    const sha = done.find((s) => s.appliedSha)?.appliedSha;
    findings.push({
      slug: `scope-${scope}-has-orphaned-siblings`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80),
      severity: openOnes.length > 3 ? 'medium' : 'low',
      scope,
      evidence: bullets([
        ...done.map(
          (s) =>
            `finished: ${s.id}@${s.status}${s.appliedSha ? ` (${s.appliedSha.slice(0, 7)})` : ''}, fixed on ${fixedOn(s, byTarget) || '?'}`,
        ),
        ...openOnes.map((s) => `pre-plan: ${s.id}@${s.status}, filed ${s.date}`),
      ]),
      context:
        `Scope \`${scope}\`: ${done.length} of ${members.length} suggestions are finished, ` +
        `${openOnes.length} sit pre-plan — ${openOnes
          .slice(0, 5)
          .map((s) => s.slug)
          .join(', ')}${openOnes.length > 5 ? `, +${openOnes.length - 5} more` : ''}. ` +
        `One fix closes a scope, so the rest are probably already fixed and unmarked.`,
      suggestion:
        `Re-read the scope file at HEAD${sha ? ` (the fix landed in ${sha.slice(0, 7)})` : ''} ` +
        'and mark each sibling superseded with a note naming where the fix lives, or confirm it is ' +
        'genuinely still open. The drain marks only the suggestion named in its commit trailer, ' +
        'which is why this happens at all.',
    });
  }
  return findings;
}

/**
 * A harness file is rung 0 by definition.
 *
 * The ladder in the skill and the guardrails file's own header both say a
 * CLAUDE.md line, a hook or a settings key is rung 0 — the harness enforces it,
 * nothing re-reads it. A suggestion scoped there and labelled 2 was still
 * caught by hand at plan time and flipped. Labels feed the queue's ranking, so
 * a wrong one is worse than a blank one; this reports the mismatch instead of
 * waiting for the plan step to notice.
 */
const HARNESS_SCOPE = /(^|\/)(claude-md-guardrails\.md|CLAUDE\.md|settings(\.local)?\.json)$|(^|\/)hooks\//;

function harnessScopeRungMismatch(state) {
  const off = state.suggestions.filter(
    (s) =>
      !isTerminal(s.status) &&
      !hasLanded(s.status) &&
      s.scope &&
      HARNESS_SCOPE.test(s.scope) &&
      s.rung !== null &&
      s.rung !== undefined &&
      s.rung !== 0,
  );
  if (off.length === 0) return [];
  return [
    {
      slug: 'harness-scoped-suggestions-not-at-rung-0',
      severity: 'low',
      scope: 'skills/kaizen/SKILL.md',
      context: `${off.length} open suggestion(s) are scoped to a harness file but labelled above rung 0: ${off
        .slice(0, 5)
        .map((s) => `${s.id} (rung ${s.rung})`)
        .join(', ')}${off.length > 5 ? `, +${off.length - 5} more` : ''}.`,
      evidence: bullets(
        off.map((s) => `${s.id}: scope \`${s.scope}\` matches ${HARNESS_SCOPE}, rung ${s.rung}`),
      ),
      suggestion:
        'A CLAUDE.md line, a hook or a settings key is rung 0 by the ladder — the harness enforces it and nothing re-reads it. Relabel with `kaizen triage --apply` (`"rung": "0"`); the plan step should not have to catch this by hand.',
    },
  ];
}

/**
 * One scope, one fix — so one live patch.
 *
 * Step 4 of the skill says one proposal per scope, and the apply cascade
 * assumes it: the commit that lands a scope's fix stamps every open sibling
 * `superseded_by: <sha>`. Two planned/approved siblings each carrying their own
 * `.patch` break that assumption — whichever lands first closes the other with
 * a diff that never landed, and a patch appended at end-of-file stops applying
 * the moment the first one lengthens the file. Seen on
 * `_lib/claude-md-guardrails.md`. Report it before either applies; the fix is
 * to fold the second diff into the lead's patch or re-scope one of them.
 */
function scopeWithSeveralLivePatches(state) {
  const findings = [];
  const byScope = new Map();
  for (const s of state.suggestions) {
    if (!s.scope || !inPatchWindow(s.status)) continue;
    // Own sidecar only, deliberately: a member covered by its lead's patch is
    // the intended shape, a second diff of its own is the hazard.
    if (!existsSync(s.file.replace(/\.md$/, '.patch'))) continue;
    const key = `${s.target}\0${s.scope}`;
    if (!byScope.has(key)) byScope.set(key, []);
    byScope.get(key).push(s);
  }
  for (const [key, live] of byScope) {
    if (live.length < 2) continue;
    const scope = key.split('\0')[1];
    findings.push({
      slug: `scope-${scope}-has-several-live-patches`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80),
      severity: 'medium',
      scope,
      context: `Scope \`${scope}\` carries ${live.length} live proposals, each with its own .patch: ${live
        .map((s) => `${s.slug}@${s.status}`)
        .join(
          ', ',
        )}. The apply cascade supersedes every open sibling when the first lands, so the other diff(s) would be stamped superseded without ever applying.`,
      evidence: bullets(live.map((s) => `${s.id}@${s.status} → ${s.file.replace(/\.md$/, '.patch')}`)),
      suggestion:
        'Fold the other diff(s) into the lead patch (one patch per scope, per Step 4) or re-scope one of them, before either is drained. If both must land in sequence, say so in blocked_on and drain them via the CLI (Step 7), which does not cascade.',
    });
  }
  return findings;
}

/**
 * A scope carrier can become stale while it waits: a member records another
 * incident, but a fenced pass on the carrier never reads that member's body.
 * Dates make the reread requirement mechanical even though deciding whether
 * the patch already covers the evidence remains a review judgement.
 */
function scopePatchMissesMemberRecurrence(state) {
  const findings = [];
  for (const carrier of state.suggestions) {
    if (!carrier.scope || !inPatchWindow(carrier.status)) continue;
    const patch = carrier.file.replace(/\.md$/, '.patch');
    if (!existsSync(patch)) continue;
    const carrierDate = String(carrier.date ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(carrierDate)) continue;

    const recent = state.suggestions.flatMap((member) => {
      if (member.id === carrier.id || member.target !== carrier.target || member.scope !== carrier.scope) {
        return [];
      }
      const recurrenceDate = /^##\s+Recurrence\s+(?:—|-)\s*(\d{4}-\d{2}-\d{2})\b/im.exec(
        member.latestRecurrence ?? '',
      )?.[1];
      return recurrenceDate && recurrenceDate >= carrierDate
        ? [`${member.id} — Recurrence ${recurrenceDate}`]
        : [];
    });
    if (recent.length === 0) continue;

    findings.push({
      slug: `scope-patch-misses-member-recurrence-${carrier.slug}`
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .slice(0, 80),
      severity: 'medium',
      scope: carrier.scope,
      context: `The live scope carrier \`${carrier.id}\`, filed ${carrierDate}, has ${recent.length} member(s) whose latest dated recurrence is at or after that date. Its patch may predate evidence that a fenced carrier pass never reads.`,
      evidence: bullets([`carrier: ${carrier.id}@${carrier.status} → ${patch}`, ...recent]),
      suggestion:
        'Re-read the named recurrence sections against the carrier patch. Amend and revalidate the patch if it misses their evidence; otherwise record that the existing patch already covers them before draining it.',
    });
  }
  return findings;
}

export const CHECKS = [
  { id: 'dead-config-key', run: () => deadConfigKeys() },
  { id: 'scope-fix-orphans-siblings', run: (ctx) => scopeFixOrphansSiblings(ctx.state, ctx.config) },
  { id: 'scope-has-several-live-patches', run: (ctx) => scopeWithSeveralLivePatches(ctx.state) },
  {
    id: 'scope-patch-misses-member-recurrence',
    run: (ctx) => scopePatchMissesMemberRecurrence(ctx.state),
  },
  { id: 'harness-scope-rung-mismatch', run: (ctx) => harnessScopeRungMismatch(ctx.state) },
  { id: 'patch-no-longer-applies', run: (ctx) => patchesThatNoLongerApply(ctx.state, ctx.config) },
  { id: 'live-patches-conflict', run: (ctx) => livePatchesConflict(ctx.state, ctx.config) },
  { id: 'decided-without-a-patch', run: (ctx) => decidedWithoutAPatch(ctx.state) },
  { id: 'stale-decision', run: (ctx) => staleDecisions(ctx.state, ctx.today) },
  { id: 'capture-quality', run: (ctx) => captureQuality(ctx.state) },
  { id: 'script-without-self-check', run: (ctx) => scriptsWithoutSelfCheck(ctx.config) },
];

/**
 * Every finding is shaped like a suggestion, because it is one. Same taxonomy,
 * same queue, same score — the app has no special case for "the tool complaining
 * about itself", which is the point.
 */
export function runDoctor({ config, state, today }) {
  const findings = [];
  for (const check of CHECKS) {
    for (const f of check.run({ config, state, today })) {
      findings.push({
        check: check.id,
        skill: 'kaizen',
        type: 'tooling',
        objective: f.slug.includes('config-key') ? 'debt' : 'guardrail',
        effort: 'M',
        rung: '1',
        status: 'recorded',
        ...f,
      });
    }
  }
  return findings;
}

/** The markdown a finding becomes, in the same shape skill-reflect produces. */
export function findingToMarkdown(f, today) {
  return [
    '---',
    `skill: ${f.skill}`,
    `date: ${today}`,
    'outcome: complete',
    `severity: ${f.severity}`,
    `scope: ${f.scope}`,
    `status: ${f.status}`,
    `type: ${f.type}`,
    `objective: ${f.objective}`,
    `rung: ${f.rung}`,
    `effort: ${f.effort}`,
    '---',
    '',
    '## Context',
    '',
    f.context,
    '',
    '## Evidence',
    '',
    f.evidence,
    '',
    '## Suggestion',
    '',
    f.suggestion,
    '',
    '## Why it matters',
    '',
    `Found by \`kaizen doctor\` (${f.check}). Kaizen runs the same loop against itself that it runs against every other skill — a finding here is not a special case, it queues and scores alongside the rest.`,
    '',
  ].join('\n');
}

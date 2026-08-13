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
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig } from './config.mjs';
import { resolveTargets } from './config.mjs';
import { inPatchWindow, patchWindow, isTerminal, hasLanded } from './lifecycle.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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
    const target = byTarget.get(s.target);
    if (!target || !existsSync(target.skills)) continue;
    try {
      execFileSync('git', ['apply', '--check', patch], { cwd: target.skills, stdio: 'pipe' });
    } catch (e) {
      findings.push({
        slug: `proposal-no-longer-applies-${s.slug}`.slice(0, 80),
        severity: 'medium',
        scope: s.scope || 'skills/kaizen/SKILL.md',
        context: `The patch beside \`${s.slug}\` no longer applies to ${target.skills}: ${
          String(e.stderr ?? e.message)
            .trim()
            .split('\n')[0]
        }`,
        suggestion:
          'Re-generate the patch against the current file, or mark the suggestion superseded if the change landed another way. A proposal that cannot apply reports as ready and fails at drain time, which is the worst moment to discover it.',
      });
    }
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
function scopeFixOrphansSiblings(state) {
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
    const openOnes = members.filter((s) => !isTerminal(s.status) && !hasLanded(s.status));
    if (done.length === 0 || openOnes.length === 0) continue;

    const sha = done.find((s) => s.appliedSha)?.appliedSha;
    findings.push({
      slug: `scope-${scope}-has-orphaned-siblings`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80),
      severity: openOnes.length > 3 ? 'medium' : 'low',
      scope,
      context:
        `Scope \`${scope}\`: ${done.length} of ${members.length} suggestions are finished, ` +
        `${openOnes.length} are not — ${openOnes
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

export const CHECKS = [
  { id: 'dead-config-key', run: () => deadConfigKeys() },
  { id: 'scope-fix-orphans-siblings', run: (ctx) => scopeFixOrphansSiblings(ctx.state) },
  { id: 'patch-no-longer-applies', run: (ctx) => patchesThatNoLongerApply(ctx.state, ctx.config) },
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

#!/usr/bin/env node
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import {
  appendSection,
  buildState,
  discoverSuggestions,
  findDuplicate,
  loadConfig,
  mine,
  proposeAliases,
  resolveSources,
  recurredAfterFix,
  scopeKey,
  resolveTargets,
  runDoctor,
  writeFrontmatter,
} from '../packages/core/src/index.mjs';

const [, , command, ...args] = argv;
const has = (name) => args.includes(`--${name}`);
const option = (name) => {
  const exact = args.indexOf(`--${name}`);
  if (exact >= 0 && args[exact + 1] && !args[exact + 1].startsWith('--')) return args[exact + 1];
  const prefix = `--${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
};

function fail(message) {
  console.error(message);
  exit(1);
}

function requireConfig() {
  const loaded = loadConfig();
  if (!loaded.exists) fail(`No config at ${loaded.path}. Create it as documented in README.md.`);
  if (loaded.errors.length) fail(`Config problems:\n  ${loaded.errors.join('\n  ')}`);
  return loaded.config;
}

/** Open items plus fixed items whose problem recurred after the fix; those carry `recurredAfterFix`. */
function workState() {
  const state = buildState(requireConfig());
  const targets = new Map(state.targets.map((target) => [target.name, target]));
  state.suggestions = state.suggestions.filter((item) => {
    if (item.status === 'open') return true;
    item.recurredAfterFix = recurredAfterFix(item, targets.get(item.target));
    return !!item.recurredAfterFix;
  });
  return state;
}

function cmdStatus() {
  const loaded = loadConfig();
  if (!loaded.exists) return;
  if (loaded.config.cadence?.sessionHook === false && !has('bar')) return;
  if (loaded.errors.length) return console.log(`kaizen: config invalid — ${loaded.errors[0]}`);
  const open = buildState(loaded.config).suggestions.filter((item) => item.status === 'open');
  const counts = new Map();
  for (const item of open) counts.set(item.skill, (counts.get(item.skill) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (has('bar')) {
    if (!top) return console.log('\x1b[2m改 ○0\x1b[0m');
    return console.log(`改 ○${open.length} ▲${top[0]}:${top[1]}`);
  }
  console.log(`kaizen: ${open.length} open${top ? ` · top: ${top[0]} (${top[1]})` : ''}`);
}

const severityRank = { high: 3, medium: 2, low: 1, '': 0 };

function listedItem(item) {
  return {
    id: item.id,
    file: item.file,
    skill: item.skill,
    target: item.target,
    status: item.status,
    recurredAfterFix: item.recurredAfterFix ?? null,
    scope: item.scope,
    severity: item.severity,
    date: item.date,
    slug: item.slug,
    recurrences: item.recurrences,
    context: item.context,
    suggestion: item.suggestion,
    evidence: item.evidence,
    patch: item.patch,
  };
}

function cmdList() {
  const by = option('by') ?? 'scope';
  if (!['scope', 'skill'].includes(by))
    fail('usage: kaizen list [--by scope|skill] [--target <name>] [--json|--text]');
  const target = option('target');
  const state = workState();
  let items = state.suggestions;
  if (target) {
    if (!state.targets.some((candidate) => candidate.name === target)) fail(`unknown target: ${target}`);
    items = items.filter((item) => item.target === target);
  }
  const groups = new Map();
  const targets = resolveTargets(requireConfig());
  for (const item of items) {
    const key = by === 'skill' ? item.skill : scopeKey(item, targets) || '(no scope)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(listedItem(item));
  }
  const output = {
    generatedAt: state.generatedAt,
    groups: [...groups]
      .map(([key, members]) => ({
        key,
        items: members.sort(
          (a, b) =>
            severityRank[b.severity] - severityRank[a.severity] ||
            b.recurrences - a.recurrences ||
            a.id.localeCompare(b.id),
        ),
      }))
      .sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key)),
  };
  if (!has('text')) return console.log(JSON.stringify(output, null, 2));
  if (!output.groups.length) return console.log('No open suggestions.');
  for (const group of output.groups) {
    console.log(`${group.key} (${group.items.length})`);
    for (const item of group.items)
      console.log(
        `  [${item.severity || '?'}] ${item.id}${item.recurrences ? ` (+${item.recurrences})` : ''}${
          item.recurredAfterFix ? ` recurred after fix ${item.recurredAfterFix.fixedOn}` : ''
        }`,
      );
  }
}

function captureMatch({ suggestions, skill, scope, slug, targets = [] }) {
  return findDuplicate({ suggestions, skill, scope, slug, targets });
}

function captureSelfCheck() {
  const suggestions = [
    {
      id: 'user/demo/open.md',
      status: 'open',
      scope: 'demo/SKILL.md',
      slug: 'keep-validation-errors-visible',
      file: '/feedback/demo/open.md',
      target: 'user',
    },
    {
      id: 'user/demo/closed.md',
      status: 'fixed',
      scope: 'closed.md',
      slug: 'closed-card-does-not-match',
      file: '/feedback/demo/closed.md',
      target: 'user',
    },
  ];
  suggestions.push(
    {
      id: 'user/babysit/2026-01-02-background-wait-ends-subagent-run.md',
      status: 'open',
      scope: 'babysit/SKILL.md',
      slug: 'background-wait-ends-subagent-run',
      file: '/feedback/babysit/background.md',
      target: 'user',
    },
    {
      id: 'user/other/2026-01-03-gh-pr-edit-blocked-by-projects.md',
      status: 'fixed',
      scope: 'lib/pr/edit-pr.sh',
      slug: 'gh-pr-edit-blocked-by-projects',
      file: '/feedback/other/fixed.md',
      target: 'user',
    },
  );
  const base = { suggestions, skill: 'demo', targets: [{ name: 'user', skills: '/skills' }] };
  const checks = [
    [
      captureMatch({ ...base, scope: '/skills/demo/SKILL.md', slug: 'other' }).match,
      'normalized scope finds the open card',
    ],
    [
      captureMatch({ ...base, scope: 'other.md', slug: 'validation-errors-should-stay-visible' }).match,
      'three shared dash-separated words find the open card',
    ],
    [
      !captureMatch({ ...base, scope: 'closed.md', slug: 'closed-card-does-not-match' }).match,
      'closed cards do not suppress a new capture',
    ],
    [
      captureMatch({ ...base, scope: 'lib/github/post-push.md', slug: 'babysit-background-ends-subagent' })
        .match === '/feedback/babysit/background.md',
      'a similar slug in another skill finds the open card',
    ],
    [
      !captureMatch({ ...base, scope: 'lib/github/post-push.md', slug: 'background-colour-token' }).match,
      'one shared word in another skill is not a duplicate',
    ],
    [
      captureMatch({ ...base, scope: 'x.md', slug: 'gh-pr-edit-projects-classic-blocked' }).fixedMatch ===
        '/feedback/other/fixed.md',
      'a fixed lookalike is reported as fixedMatch, not match',
    ],
  ];
  for (const [passed, label] of checks) console.log(`${passed ? 'ok  ' : 'FAIL'} ${label}`);
  if (checks.some(([passed]) => !passed)) exit(1);
}

function cmdCapture() {
  if (has('self-check')) return captureSelfCheck();
  const skill = option('skill');
  const scope = option('scope');
  const slug = option('slug');
  if (!has('check') || !skill || !scope || !slug)
    return console.log(
      JSON.stringify({
        match: null,
        reason: 'usage: kaizen capture --check --skill <name> --scope <path> --slug <slug>',
      }),
    );
  const loaded = loadConfig();
  if (!loaded.exists || loaded.errors.length)
    return console.log(
      JSON.stringify({
        match: null,
        reason: loaded.exists
          ? `config is invalid: ${loaded.errors.join('; ')}`
          : `no config at ${loaded.path}`,
      }),
    );
  try {
    const targets = resolveTargets(loaded.config);
    const suggestions = targets.flatMap((target) =>
      target.feedback ? discoverSuggestions(target.feedback, target.name, target.skills) : [],
    );
    console.log(JSON.stringify(captureMatch({ suggestions, skill, scope, slug, targets })));
  } catch (error) {
    console.log(JSON.stringify({ match: null, reason: `capture check unavailable: ${error.message}` }));
  }
}

function batchFromArguments() {
  const json = option('json');
  if (json !== undefined) {
    const text = json === '-' ? readFileSync(0, 'utf8') : readFileSync(json, 'utf8');
    let entries;
    try {
      entries = JSON.parse(text);
    } catch (error) {
      fail(`invalid close JSON: ${error.message}`);
    }
    if (!Array.isArray(entries)) fail('close JSON must be an array');
    return entries.map((entry) => {
      if (!entry || typeof entry.id !== 'string') fail('each close JSON entry must have an id');
      const fixed = typeof entry.fixed === 'string' ? entry.fixed : '';
      const dropped = typeof entry.dropped === 'string' ? entry.dropped : '';
      if (!!fixed === !!dropped)
        fail(`close JSON entry ${entry.id} must have exactly one of fixed or dropped`);
      return { id: entry.id, status: fixed ? 'fixed' : 'dropped', value: fixed || dropped };
    });
  }
  const fixed = option('fixed');
  const dropped = option('dropped');
  if (!!fixed === !!dropped) fail('usage: kaizen close <id>... (--fixed <sha> | --dropped <reason>)');
  const ids = args.filter((argument, index) => {
    if (argument.startsWith('--')) return false;
    return !['--fixed', '--dropped'].includes(args[index - 1]);
  });
  if (!ids.length) fail('close requires at least one suggestion id');
  return ids.map((id) => ({ id, status: fixed ? 'fixed' : 'dropped', value: fixed || dropped }));
}

function cmdClose() {
  const batch = batchFromArguments();
  const state = buildState(requireConfig());
  const targets = new Map(state.targets.map((target) => [target.name, target]));
  const byId = new Map(state.suggestions.map((item) => [item.id, item]));
  const duplicate = batch.find(
    (entry, index) => batch.findIndex((candidate) => candidate.id === entry.id) !== index,
  );
  if (duplicate) fail(`duplicate suggestion id: ${duplicate.id}`);
  for (const entry of batch) {
    const item = byId.get(entry.id);
    if (!item) fail(`unknown suggestion id: ${entry.id}`);
    // A fixed item that recurred after its fix is back in the backlog, so it can be closed again.
    if (item.status !== 'open' && !recurredAfterFix(item, targets.get(item.target)))
      fail(`suggestion is already closed: ${entry.id}`);
    if (!entry.value.trim() || /[\r\n]/.test(entry.value))
      fail(`close value must be one non-empty line: ${entry.id}`);
  }
  const closedAt = new Date().toISOString();
  const originals = new Map(
    batch.map((entry) => [byId.get(entry.id).file, readFileSync(byId.get(entry.id).file, 'utf8')]),
  );
  try {
    for (const entry of batch) {
      const item = byId.get(entry.id);
      const fixed = entry.status === 'fixed';
      writeFrontmatter(item.file, {
        status: entry.status,
        closed_at: closedAt,
        fixed_by: fixed ? entry.value : null,
        dropped_reason: fixed ? null : entry.value,
      });
      appendSection(
        item.file,
        'Resolution',
        fixed ? `Fixed by \`${entry.value}\`.` : `Dropped: ${entry.value}`,
      );
    }
  } catch (error) {
    for (const [file, text] of originals) writeFileSync(file, text);
    fail(`close failed; no suggestions were changed: ${error.message}`);
  }
  console.log(`closed ${batch.length} suggestion(s)`);
}

function cmdDoctor() {
  const config = requireConfig();
  const findings = runDoctor({ config, state: buildState(config) });
  if (!findings.length) return console.log('kaizen doctor: no findings');
  for (const finding of findings) console.log(`[${finding.severity}] ${finding.check}: ${finding.message}`);
  console.log(`${findings.length} finding(s)`);
}

function cmdAliases() {
  const state = buildState(requireConfig());
  const proposals = proposeAliases(state).filter(
    (proposal) => Object.keys(proposal.aliases).length || proposal.unresolved.length,
  );
  if (!has('text'))
    return console.log(JSON.stringify({ generatedAt: state.generatedAt, proposals }, null, 2));
  if (!proposals.length) return console.log('Every scope resolves to an existing file.');
  for (const { target, aliases, unresolved } of proposals) {
    console.log(`target "${target}": add to its config entry`);
    console.log(JSON.stringify({ scopeAliases: aliases }, null, 2));
    if (unresolved.length) console.log(`unresolved (${unresolved.length}):\n  ${unresolved.join('\n  ')}`);
  }
}

async function cmdMine() {
  const config = requireConfig();
  const days = option('days') === undefined ? undefined : Number(option('days'));
  if (days !== undefined && (!Number.isInteger(days) || days < 1)) fail('--days must be a positive integer');
  const limit = Number(option('limit') ?? 20);
  const sources = resolveSources(config);
  const report = await mine({
    projectsDir: sources.projects,
    facetsDir: sources.facets,
    feedbackDirs: resolveTargets(config)
      .map((target) => target.feedback)
      .filter(Boolean),
    days,
  });
  if (!has('text')) return console.log(JSON.stringify(report, null, 2));
  const { parse, capture } = report;
  console.log('kaizen mine — candidates only; nothing was filed.');
  console.log(
    `\nread ${parse.transcripts} transcript(s), ${parse.lines} line(s); ${parse.unparsedLines} unparsed, ${parse.untimed} without timestamp, ${parse.unreadable.length} unreadable file(s); ${parse.facets} facet file(s), ${parse.unparsedFacets.length} unparsed`,
  );
  console.log(
    `\ncapture recall: ${capture.captured}/${capture.evaluated} friction session(s) wrote a capture${
      capture.recall === null ? '' : ` (${Math.round(capture.recall * 100)}%)`
    }; ${capture.unevaluated.length} could not be evaluated`,
  );
  for (const [category, count] of Object.entries(capture.frictionTotals).sort((a, b) => b[1] - a[1]))
    console.log(`  ${count}× ${category}`);
  for (const session of capture.missed.slice(0, limit))
    console.log(
      `  missed ${session.sessionId} [${Object.keys(session.friction).join(', ')}] ${session.summary}`,
    );
  console.log(`\nhook blocks (${report.hookBlocks.reduce((sum, block) => sum + block.count, 0)}):`);
  for (const block of report.hookBlocks.slice(0, limit))
    console.log(`  ${block.count}× ${block.guard}: ${block.trap}`);
  console.log(`\ncorrection-like messages (${report.corrections.length}):`);
  for (const item of report.corrections.slice(-limit))
    console.log(`  ${item.timestamp.slice(0, 10)} ${item.project}: ${item.text}`);
  console.log('\nskill runs (time to next human message):');
  for (const run of report.skillRuns.slice(0, limit))
    console.log(
      `  ${run.skill}: ${run.runs} run(s), median ${run.medianSeconds === null ? '?' : Math.round(run.medianSeconds)}s, ${run.outputTokens} output tokens, ${run.unfinished} unfinished`,
    );
}

function dateAge(value) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? -Infinity : (Date.now() - time) / 86400000;
}

function cmdPrune() {
  const days = Number(option('days') ?? 30);
  if (!Number.isInteger(days) || days < 0) fail('--days must be a non-negative integer');
  const stale = buildState(requireConfig()).suggestions.filter(
    (item) => item.status !== 'open' && dateAge(item.closedAt || item.date) > days,
  );
  for (const item of stale) {
    console.log(`${has('dry-run') ? 'would prune' : 'pruned'} ${item.id}`);
    if (!has('dry-run')) {
      rmSync(item.file, { force: true });
      rmSync(item.file.replace(/\.md$/, '.patch'), { force: true });
    }
  }
  console.log(
    `${has('dry-run') ? 'would prune' : 'pruned'} ${stale.length} closed suggestion(s) older than ${days} days`,
  );
}

const lifecycleKeys = [
  'needs_review',
  'approved_patch',
  'blocked_on',
  'confirmed_at',
  'type',
  'objective',
  'rung',
  'effort',
];

function firstLine(...values) {
  for (const value of values) {
    const line = value.split(/\r?\n/).find((candidate) => candidate.trim());
    if (line) return line.trim();
  }
  return '';
}

function migrationFor(item) {
  const status = item.rawStatus;
  if (status === 'fixed' || status === 'dropped') return { status, value: '' };
  if (status === 'verified') return { status: 'fixed', value: item.appliedSha };
  if (status === 'superseded' || status === 'rejected')
    return { status: 'dropped', value: firstLine(item.verdict, item.answer) || status };
  if ((status === 'applied' || status === 'reviewed') && item.appliedSha)
    return { status: 'fixed', value: item.appliedSha };
  return { status: 'open', value: '' };
}

function cmdMigrate() {
  const state = buildState(requireConfig());
  const counts = new Map();
  for (const item of state.suggestions) {
    const next = migrationFor(item);
    const from = item.rawStatus || '(missing)';
    const key = `${from} -> ${next.status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (has('dry-run')) continue;
    const patch = Object.fromEntries(lifecycleKeys.map((name) => [name, null]));
    patch.status = next.status;
    patch.fixed_by = next.status === 'fixed' && next.value ? next.value : null;
    patch.dropped_reason = next.status === 'dropped' ? next.value : null;
    writeFrontmatter(item.file, patch);
  }
  for (const [transition, count] of [...counts].sort()) console.log(`${transition}: ${count}`);
  console.log(`${has('dry-run') ? 'would migrate' : 'migrated'} ${state.suggestions.length} suggestion(s)`);
}

function help() {
  console.log(
    `usage: kaizen <command>\n\ncommands:\n  status [--bar]\n  list [--by scope|skill] [--target <name>] [--json|--text]\n  capture --check --skill <name> --scope <path> --slug <slug>\n  close <id>... (--fixed <sha> | --dropped <reason>)\n  close --json <file|->\n  doctor\n  aliases [--json|--text]\n  mine [--days N] [--limit N] [--json|--text]\n  prune [--days N] [--dry-run]\n  migrate [--dry-run]`,
  );
}

const commands = {
  status: cmdStatus,
  list: cmdList,
  capture: cmdCapture,
  close: cmdClose,
  doctor: cmdDoctor,
  aliases: cmdAliases,
  mine: cmdMine,
  prune: cmdPrune,
  migrate: cmdMigrate,
  help,
};

if (!command || command === '--help' || command === '-h') help();
else if (!commands[command]) fail(`unknown command: ${command}`);
else commands[command]();

#!/usr/bin/env node
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import {
  appendSection,
  buildState,
  discoverSuggestions,
  loadConfig,
  normalizeScope,
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

function openState() {
  const state = buildState(requireConfig());
  state.suggestions = state.suggestions.filter((item) => item.status === 'open');
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
  const state = openState();
  let items = state.suggestions;
  if (target) {
    if (!state.targets.some((candidate) => candidate.name === target)) fail(`unknown target: ${target}`);
    items = items.filter((item) => item.target === target);
  }
  const groups = new Map();
  for (const item of items) {
    const key = by === 'skill' ? item.skill : item.scope || '(no scope)';
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
        `  [${item.severity || '?'}] ${item.id}${item.recurrences ? ` (+${item.recurrences})` : ''}`,
      );
  }
}

const slugWords = (slug) =>
  new Set(
    String(slug ?? '')
      .toLowerCase()
      .split('-')
      .filter(Boolean),
  );

function captureMatch({ suggestions, skill, scope, slug, skillsByTarget = new Map() }) {
  const open = suggestions.filter(
    (item) => (item.id.split('/')[1] || item.skill) === skill && item.status === 'open',
  );
  const sameScope = scope
    ? open.find(
        (item) => item.scope && item.scope === normalizeScope(scope, skillsByTarget.get(item.target) ?? ''),
      )
    : null;
  if (sameScope) return { match: sameScope.file, reason: `same normalized scope: ${sameScope.scope}` };
  const incoming = slugWords(slug);
  for (const item of open) {
    const shared = [...slugWords(item.slug)].filter((word) => incoming.has(word)).sort();
    if (shared.length >= 3)
      return {
        match: item.file,
        reason: `slug shares ${shared.length} dash-separated words: ${shared.join(', ')}`,
      };
  }
  return {
    match: null,
    reason: `no open suggestion in skill "${skill}" shares its normalized scope or three slug words`,
  };
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
  const base = { suggestions, skill: 'demo', skillsByTarget: new Map([['user', '/skills']]) };
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
    console.log(
      JSON.stringify(
        captureMatch({
          suggestions,
          skill,
          scope,
          slug,
          skillsByTarget: new Map(targets.map((target) => [target.name, target.skills])),
        }),
      ),
    );
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
  const byId = new Map(state.suggestions.map((item) => [item.id, item]));
  const duplicate = batch.find(
    (entry, index) => batch.findIndex((candidate) => candidate.id === entry.id) !== index,
  );
  if (duplicate) fail(`duplicate suggestion id: ${duplicate.id}`);
  for (const entry of batch) {
    const item = byId.get(entry.id);
    if (!item) fail(`unknown suggestion id: ${entry.id}`);
    if (item.status !== 'open') fail(`suggestion is already closed: ${entry.id}`);
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
    `usage: kaizen <command>\n\ncommands:\n  status [--bar]\n  list [--by scope|skill] [--target <name>] [--json|--text]\n  capture --check --skill <name> --scope <path> --slug <slug>\n  close <id>... (--fixed <sha> | --dropped <reason>)\n  close --json <file|->\n  doctor\n  prune [--days N] [--dry-run]\n  migrate [--dry-run]`,
  );
}

const commands = {
  status: cmdStatus,
  list: cmdList,
  capture: cmdCapture,
  close: cmdClose,
  doctor: cmdDoctor,
  prune: cmdPrune,
  migrate: cmdMigrate,
  help,
};

if (!command || command === '--help' || command === '-h') help();
else if (!commands[command]) fail(`unknown command: ${command}`);
else commands[command]();

#!/usr/bin/env node
/**
 * kaizen — one entry point, a few subcommands.
 *
 *   init      interactive setup; discovers or asks, never assumes
 *   scan      emit the full state as JSON
 *   status    one line, for the session hook
 *   validate  check suggestion frontmatter against the schema (--fix normalises)
 *   triage    apply a batch of triage decisions to frontmatter (--self-check)
 *   asks      the asks you keep repeating (--json for the weekly pass)
 *   doctor    run kaizen's own rubric against kaizen (--file queues findings)
 *   docs      regenerate what lifecycle.json implies (--check fails on drift)
 *   serve     start the local app + API
 *   tui       the queue in the terminal (starts `serve` if the port is dead)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';
import {
  loadConfig,
  saveConfig,
  defaultConfig,
  buildState,
  parseFrontmatter,
  writeFrontmatter,
  TYPES,
  OBJECTIVES,
  EFFORTS,
  SEVERITIES,
  STATUSES,
  resolveTargets,
  runDoctor,
  findingToMarkdown,
  loadLifecycle,
  validateLifecycle,
  awaitingDecision,
  entryStatus,
  discoverSuggestions,
  surfaceOf,
  passesSurface,
  categorize,
  readAsks,
  passDue,
  windowDays,
  stampPath,
  canonicalStatus,
  isTerminal,
  hasLanded,
  canTransition,
  nextStatuses,
  missingRequirements,
  renderMarkdown,
} from '@kaizen/core';

const [, , command = 'status', ...args] = argv;
const has = (flag) => args.includes(flag);
const here = dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------- init ---- */

/**
 * Look in the places Claude Code actually keeps skills. Presented as candidates
 * to confirm, not applied silently — the point is that this works on a machine
 * whose layout we have never seen.
 */
function candidateTargets() {
  const home = homedir();
  const out = [];
  const userSkills = join(home, '.claude', 'skills');
  if (existsSync(userSkills)) {
    out.push({
      name: 'user',
      skills: '~/.claude/skills',
      feedback: '~/.claude/skills-feedback',
      writable: true,
      note: 'your personal skills',
    });
  }
  const projectSkills = join(process.cwd(), '.claude', 'skills');
  if (existsSync(projectSkills)) {
    out.push({
      name: 'project',
      skills: join(process.cwd(), '.claude', 'skills'),
      feedback: join(process.cwd(), '.claude', 'skills-feedback'),
      writable: true,
      note: 'skills in the current project',
    });
  }
  return out;
}

/** Read a flag's value: `--depth 3` or `--depth=3`. */
function flag(name) {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}

async function cmdInit() {
  // The common way to reach this is a slash command in Claude Code, where stdin
  // is not a terminal. Prompting there would hang forever, so a non-TTY run
  // takes the detected defaults and prints exactly what it chose.
  const interactive = stdin.isTTY && !has('--yes');

  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  const ask = async (q, dflt = '') => {
    if (!rl) return dflt;
    const a = (await rl.question(dflt ? `${q} [${dflt}] ` : `${q} `)).trim();
    return a || dflt;
  };
  const yes = async (q, dflt = true) => {
    if (!rl) return dflt;
    const a = (await ask(q, dflt ? 'Y/n' : 'y/N')).toLowerCase();
    if (a === 'y/n' || a === 'y/n'.toUpperCase()) return dflt;
    if (a.startsWith('y')) return true;
    if (a.startsWith('n')) return false;
    return dflt;
  };

  console.log('\nkaizen setup\n');
  if (!interactive) {
    console.log('Not a terminal — accepting detected defaults. Flags: --scan <roots> --depth N.\n');
  }
  const { config: existing, exists, path } = loadConfig();
  const config = exists ? existing : defaultConfig();
  if (exists) console.log(`Updating existing config at ${path}\n`);

  const found = candidateTargets();
  const targets = [];
  for (const c of found) {
    if (await yes(`Watch ${c.skills} (${c.note})?`)) {
      targets.push({ name: c.name, skills: c.skills, feedback: c.feedback, writable: c.writable });
    }
  }

  if (targets.length === 0) {
    console.log('\nNo skills directory found automatically.');
    const dir = await ask('Path to your skills directory (blank to skip):');
    if (dir) {
      const fb = await ask('Path to store suggestions:', dir.replace(/skills\/?$/, 'skills-feedback'));
      targets.push({ name: 'user', skills: dir, feedback: fb, writable: true });
    }
  }
  config.targets = targets;

  console.log('');
  const scanFlag = flag('scan');
  const wantScan =
    scanFlag !== undefined || (await yes('Also look for skills inside project repositories?', false));

  if (wantScan) {
    const rootsRaw = scanFlag ?? (await ask('Directories to search (comma separated):', process.cwd()));
    config.scan = {
      enabled: true,
      roots: rootsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      depth: Number(flag('depth') ?? (await ask('How many directory levels deep?', '3'))) || 3,
      // Reporting on someone else's repo is safe; patching it is not.
      writable: false,
    };
    console.log('  Project skills are read-only — kaizen reports on them but will not patch them.');
  } else {
    config.scan = { ...defaultConfig().scan };
  }

  console.log('');
  config.cadence.weekly = await ask(
    'Weekly triage pass (e.g. "SUN 09:00", or "off"):',
    config.cadence.weekly,
  );
  config.cadence.sessionHook = await yes('Print a one-line backlog status each session?', true);

  rl?.close();

  try {
    saveConfig(config);
  } catch (e) {
    console.error(`\n${e.message}`);
    exit(1);
  }

  console.log(`\nSaved ${loadConfig().path}`);
  const state = buildState(config);
  for (const w of state.warnings) console.log(`  warning: ${w}`);
  console.log(
    `\nFound ${state.skills.length} skills and ${state.metrics.total} suggestions ` +
      `(${state.metrics.incidents} incidents, ${state.metrics.categories} categories).`,
  );
  console.log('\nNext: `kaizen serve` to open the app, or run /kaizen:triage in Claude Code.\n');
}

/* ---------------------------------------------------------- scan/status ---- */

function requireConfig() {
  const { config, exists, path, errors } = loadConfig();
  if (!exists) {
    console.error(`No config at ${path}. Run \`kaizen init\` first.`);
    exit(1);
  }
  if (errors.length) {
    console.error(`Config problems:\n  ${errors.join('\n  ')}`);
    exit(1);
  }
  return config;
}

function cmdScan() {
  const state = buildState(requireConfig());
  stdout.write(JSON.stringify(state, null, has('--pretty') ? 2 : 0));
}

/**
 * The session hook calls this. It must stay cheap and quiet: one line, no model,
 * and silence when there is genuinely nothing to say.
 */
/**
 * The status bar segment — concept A of the 2026-08-09 proposals: pile shapes.
 *
 *   改 ○17 ●1 ◐22 ▲9
 *
 * The dot's fill IS the state: ○ unjudged (to triage), ● a decision that is
 * yours — the only amber thing, because it is the only thing that ever needs
 * you — ◐ half-done (landed, unverified), ▲ the hottest promoted category
 * with open work. Zero segments vanish; an empty backlog is a dim 改, which
 * proves the segment is alive without saying anything.
 *
 * Runs on every status-line refresh, so it reads suggestions only — no skills
 * discovery, no project scan, no git. And it never errors out loud: a bar that
 * prints a stack trace every few seconds is worse than no bar.
 */
function cmdBar() {
  const paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
  try {
    const { config, exists, errors } = loadConfig();
    if (!exists || errors.length) return;

    const suggestions = [];
    const seen = new Set();
    for (const t of resolveTargets(config)) {
      if (!t.feedback || seen.has(t.feedback)) continue;
      seen.add(t.feedback);
      suggestions.push(...discoverSuggestions(t.feedback, t.name));
    }

    const surface = surfaceOf(config);
    const surfaced = suggestions.filter((s) => passesSurface(s, surface));
    const entry = entryStatus();
    const wants = awaitingDecision();
    const toTriage = surfaced.filter((s) => s.status === entry).length;
    const deciding = surfaced.filter((s) => wants.includes(s.status)).length;
    const landed = surfaced.filter((s) => hasLanded(s.status) && !isTerminal(s.status)).length;

    // Same rule as the session line: a category is only worth pointing at
    // while something in it is still open work.
    const open = new Set(
      surfaced.filter((s) => !isTerminal(s.status) && !hasLanded(s.status)).map((s) => s.id),
    );
    const categories = categorize(suggestions, { promotion: config.categoryPromotion });
    const top = categories.find((c) => c.promoted && c.members.some((m) => open.has(m)));

    const parts = [];
    if (toTriage) parts.push(paint('36', `○${toTriage}`));
    if (deciding) parts.push(paint('1;33', `●${deciding}`));
    if (landed) parts.push(paint('34', `◐${landed}`));
    if (top) parts.push(paint('31', `▲${top.incidents}`));

    if (parts.length === 0) return console.log(paint('2', '改'));
    console.log(`${paint('36', '改')} ${parts.join(' ')}`);
  } catch {
    /* silence — the bar has no business breaking a prompt */
  }
}

function cmdStatus() {
  // The bar ignores the sessionHook toggle on purpose: it only ever renders
  // because the user wired it into their statusLine command themselves.
  if (has('--bar')) return cmdBar();
  const { config, exists, errors } = loadConfig();
  if (!exists) return;
  // The Settings toggle has to mean something, and this is its only reader. It
  // sits above the invalid-config branch on purpose: off means off, including
  // when the config is broken. `kaizen scan` stays the way to see everything.
  if (config.cadence?.sessionHook === false) return;
  if (errors.length) {
    console.log(`kaizen: config invalid — ${errors[0]}`);
    return;
  }
  let state;
  try {
    state = buildState(config);
  } catch {
    return;
  }
  const { categories } = state;

  // Counted over what the user asked to see, not over everything on disk. The
  // dashboard's header still reports the full totals; this line is the one that
  // interrupts, so it obeys the filter.
  const surfaced = state.suggestions.filter((s) => s.surfaced);
  if (surfaced.length === 0) return;

  const parts = [];
  const untriaged = surfaced.filter((s) => !s.triaged).length;
  if (untriaged) parts.push(`${untriaged} untriaged`);
  // The pile at the entry, which a triage pass consumes. Distinct from
  // `untriaged`: that means "has no labels", this means "nobody has confirmed
  // the problem is still real". A file can be fully labelled and still sit here.
  const entry = entryStatus();
  const toTriage = surfaced.filter((s) => s.status === entry).length;
  if (toTriage) parts.push(`${toTriage} to triage`);
  // Only the pile at the door of the attended phase actually wants Mario. This
  // used to count `approved` too, which waits on the server — that is how the
  // line came to report 39 items needing nothing from anyone.
  const wants = awaitingDecision();
  const ready = surfaced.filter((s) => wants.includes(s.status)).length;
  if (ready) parts.push(`${ready} awaiting you`);
  // A category is worth naming only while something in it is still open work —
  // surfaced, no commit landed, not terminal. One whose members are all applied
  // or superseded is history, and it was headlining every session as "top".
  const ids = new Set(surfaced.filter((s) => !isTerminal(s.status) && !hasLanded(s.status)).map((s) => s.id));
  const top = categories.find((c) => c.promoted && c.members.some((m) => ids.has(m)));
  if (top) parts.push(`top: ${top.id} (${top.incidents})`);
  if (parts.length === 0) return;
  console.log(`kaizen: ${parts.join(' · ')}`);
}

/* ------------------------------------------------------------ validate ---- */

/**
 * What the *capture* step owes us. Not the taxonomy — that is triage's job — but
 * `scope` is here on purpose: the skill that just ran is the only thing that
 * knows which file it would have fixed, and without it a suggestion can only group under its skill
 * vocabulary alone. It went unwritten 66 times while being merely requested.
 */
const REQUIRED = ['skill', 'date', 'severity', 'scope'];

function cmdValidate() {
  const config = requireConfig();
  const state = buildState(config);
  const fix = has('--fix');
  const strict = has('--strict');
  let problems = 0;
  let fixed = 0;
  /** Spec-conformance gaps, grouped by what is missing rather than by file. */
  const gaps = {};

  for (const s of state.suggestions) {
    const issues = [];
    const { data } = parseFrontmatter(readFileSync(s.file, 'utf8'));
    for (const key of REQUIRED) if (!data[key]) issues.push(`missing ${key}`);
    if (data.severity && !SEVERITIES.includes(data.severity)) issues.push(`bad severity "${data.severity}"`);
    if (data.status && !STATUSES.includes(data.status)) issues.push(`bad status "${data.status}"`);
    if (data.type && !TYPES.includes(data.type)) issues.push(`bad type "${data.type}"`);
    if (data.objective && !OBJECTIVES.includes(data.objective))
      issues.push(`bad objective "${data.objective}"`);
    if (data.effort && !EFFORTS.includes(data.effort)) issues.push(`bad effort "${data.effort}"`);

    if (fix) {
      // Only fills in what is mechanically derivable — never guesses a severity
      // or a type, because a wrong label is worse than a missing one.
      const patch = {};
      if (!data.skill) patch.skill = s.skill;
      if (!data.date && s.date) patch.date = s.date;
      if (!data.status) patch.status = 'recorded';
      if (Object.keys(patch).length) {
        writeFrontmatter(s.file, patch);
        fixed++;
      }
    }
    if (issues.length) {
      problems++;
      console.log(`${s.id}\n  ${issues.join('\n  ')}`);
    }

    // Separately: does the file carry what its own phase is supposed to have
    // produced? This is conformance to the lifecycle spec rather than to the
    // frontmatter schema, and it is deliberately not fatal by default. Every
    // file written before the spec existed is missing `evidence`, and turning
    // the whole corpus red would train everyone to ignore the command — which
    // is exactly how the old green ("0 with problems") came to mean nothing.
    for (const field of missingRequirements(s.status, {
      data,
      body: readFileSync(s.file, 'utf8'),
      hasPatch: existsSync(s.file.replace(/\.md$/, '.patch')),
    })) {
      (gaps[`${s.status} is missing ${field}`] ??= []).push(s.slug);
    }
  }

  console.log(
    `\n${state.suggestions.length} files · ${problems} with problems` +
      (fix ? ` · ${fixed} normalised` : '') +
      `\n${state.metrics.untriaged} untriaged (missing taxonomy — that is triage work, not a schema error)`,
  );

  const gapEntries = Object.entries(gaps).sort((a, b) => b[1].length - a[1].length);
  if (gapEntries.length) {
    console.log('\nlifecycle conformance (what each phase was supposed to leave behind):');
    for (const [what, slugs] of gapEntries) {
      console.log(
        `  ${String(slugs.length).padStart(4)}  ${what}` +
          (slugs.length <= 3 ? ` — ${slugs.join(', ')}` : ''),
      );
    }
    console.log('  A file written before the spec cannot grow these retroactively; --strict fails on them.');
  }

  if (problems && !fix) exit(1);
  if (strict && gapEntries.length) exit(1);
}

/* -------------------------------------------------------------- triage ---- */

/** Fields a triage pass is allowed to set, and what each accepts. */
const TRIAGE_FIELDS = {
  type: TYPES,
  objective: OBJECTIVES,
  effort: EFFORTS,
  severity: SEVERITIES,
  status: STATUSES,
  rung: ['0', '1', '2', '3'],
  scope: null, // free text: a path, checked for being non-empty only
  category: null,
  // The triage phase's own output: which commit the problem was last confirmed
  // to still exist at. Without it a pass cannot legally reach `triaged`, and the
  // 27 already-fixed suggestions this check exists for stay invisible.
  confirmed_at: null,
  // Remapping an orphan onto its successor is a triage decision, and the
  // edge-case list already calls for it. The folder is the scanner's signal, so
  // a remap is a move plus this field.
  skill: null,
  // The verify phase's own output: when the validation plan ran and what it
  // returned. Without this key the unattended verify pass had no mechanical
  // writer and Step 7 forced the hand-editing the skill forbids.
  verified_at: null,
};

/** Turn a decision list into writes, or into every reason it cannot be one. */
function validateDecisions(decisions, byId) {
  const errors = [];
  const writes = [];

  for (const [n, d] of decisions.entries()) {
    const where = `decisions[${n}]`;
    const found = byId.get(d?.id);
    if (!found) {
      errors.push(`${where}: no suggestion with id "${d?.id}"`);
      continue;
    }
    const patch = {};
    for (const [key, value] of Object.entries(d)) {
      if (key === 'id') continue;
      if (!(key in TRIAGE_FIELDS)) {
        errors.push(`${where}: "${key}" is not a triage field`);
        continue;
      }
      const allowed = TRIAGE_FIELDS[key];
      const text = String(value);
      if (allowed && !allowed.includes(text)) {
        errors.push(`${where}.${key}: "${text}" must be one of ${allowed.join(', ')}`);
        continue;
      }
      if (!allowed && !text.trim()) {
        errors.push(`${where}.${key}: must not be empty`);
        continue;
      }
      patch[key] = text;
    }
    if (Object.keys(patch).length) writes.push({ file: found.file, id: found.id, patch });
  }
  return { errors, writes };
}

/* --------------------------------------------------------------- drain ---- */

/** Shortest legal path from a status to `verified`, straight off the spec. */
function drainPath(from) {
  const start = canonicalStatus(from) ?? 'recorded';
  const queue = [[start]];
  const seen = new Set([start]);
  while (queue.length) {
    const path = queue.shift();
    const cur = path.at(-1);
    if (cur === 'verified') return path.slice(1);
    for (const n of nextStatuses(cur)) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push([...path, n]);
      }
    }
  }
  return null;
}

/**
 * Walk one suggestion all the way to `verified`, in one call.
 *
 * The 2026-08-09 pass did this by hand: four `triage --apply` batches plus an
 * ad-hoc script for `applied_sha`, twice. That walk is pure mechanics — the
 * path comes from the spec, every hop's requirements are the same checks the
 * server runs, and the two stamps are fixed keys. What stays with the model is
 * everything before this: the patch, the commit, and the validation run whose
 * result `verified_at` records.
 *
 *   kaizen drain --apply stamps.json    # [{ id, sha, verified_at }]
 *   kaizen drain --apply - < stamps.json
 */
function cmdDrain() {
  const i = args.indexOf('--apply');
  const source = i === -1 ? null : args[i + 1];
  if (!source) {
    console.error('usage: kaizen drain --apply <file.json|-> [--dry-run]');
    exit(1);
  }
  let entries;
  try {
    entries = JSON.parse(source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8'));
  } catch (e) {
    console.error(`could not read stamps: ${e.message}`);
    exit(1);
  }
  if (!Array.isArray(entries)) {
    console.error('stamps must be a JSON array of { id, sha, verified_at }');
    exit(1);
  }

  const config = requireConfig();
  const byId = new Map(buildState(config).suggestions.map((s) => [s.id, s]));
  const errors = [];
  const writes = [];

  for (const [n, e] of entries.entries()) {
    const where = `stamps[${n}]`;
    const found = byId.get(e?.id);
    if (!found) {
      errors.push(`${where}: no suggestion with id "${e?.id}"`);
      continue;
    }
    if (!/^[0-9a-f]{7,40}$/i.test(String(e.sha ?? ''))) {
      errors.push(`${where}.sha: not a commit hash`);
      continue;
    }
    if (!String(e.verified_at ?? '').trim()) {
      errors.push(`${where}.verified_at: must say when the validation ran and what it returned`);
      continue;
    }
    const path = drainPath(found.status);
    if (path === null) {
      errors.push(`${where}: "${found.status}" cannot reach verified (terminal, or off the pipeline)`);
      continue;
    }
    // The same gates the server holds: every hop's phase must have what it
    // requires, judged against the file as it will be after the stamps land.
    const text = readFileSync(found.file, 'utf8');
    const { data, body } = parseFrontmatter(text);
    const merged = { ...data, applied_sha: e.sha, verified_at: e.verified_at };
    const hasPatch = existsSync(found.file.replace(/\.md$/, '.patch'));
    for (const step of path) {
      for (const f of missingRequirements(step, { data: merged, body, hasPatch })) {
        errors.push(`${where}: cannot pass "${step}" — missing ${f}`);
      }
    }
    writes.push({
      file: found.file,
      patch: { status: 'verified', applied_sha: e.sha, verified_at: e.verified_at },
    });
  }

  if (errors.length) {
    console.error(`refusing to write — ${errors.length} problem(s):\n  ${errors.join('\n  ')}`);
    exit(1);
  }
  const dry = has('--dry-run');
  for (const w of writes) if (!dry) writeFrontmatter(w.file, w.patch);
  console.log(`${dry ? 'would stamp' : 'stamped'} ${writes.length} suggestion(s) verified`);
}

/**
 * Apply a batch of triage decisions to suggestion frontmatter.
 *
 * The judgement — which label fits this suggestion — is genuinely rung 2 and
 * stays with the model. Turning a decision into a correct frontmatter edit is
 * rung 1: it is the same five keys every time, the vocabularies are closed, and
 * doing it by hand across sixty files is exactly the mechanical work this tool
 * exists to remove. Without this the skill asked its own core loop to be done at
 * rung 3.
 *
 *   kaizen triage --apply decisions.json      # [{ id, type, objective, ... }]
 *   kaizen triage --apply - < decisions.json
 *   kaizen triage --self-check
 */
function cmdTriage() {
  if (has('--self-check')) return triageSelfCheck();

  const i = args.indexOf('--apply');
  const source = i === -1 ? null : args[i + 1];
  if (!source) {
    console.error('usage: kaizen triage --apply <file.json|-> [--dry-run]');
    exit(1);
  }

  let decisions;
  try {
    decisions = JSON.parse(source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8'));
  } catch (e) {
    console.error(`could not read decisions: ${e.message}`);
    exit(1);
  }
  if (!Array.isArray(decisions)) {
    console.error('decisions must be a JSON array of { id, ...fields }');
    exit(1);
  }

  const config = requireConfig();
  const byId = new Map(buildState(config).suggestions.map((s) => [s.id, s]));
  const dry = has('--dry-run');
  const { errors, writes } = validateDecisions(decisions, byId);

  // All or nothing. A batch that half-applies leaves the queue in a state nobody
  // planned, and the whole point is that the next scan is trustworthy.
  if (errors.length) {
    console.error(`refusing to write — ${errors.length} problem(s):\n  ${errors.join('\n  ')}`);
    exit(1);
  }

  for (const w of writes) if (!dry) writeFrontmatter(w.file, w.patch);

  const after = dry ? null : buildState(loadConfig().config).metrics;
  console.log(
    `${dry ? 'would update' : 'updated'} ${writes.length} suggestion(s)` +
      (after ? ` · ${after.untriaged} still untriaged of ${after.total}` : ''),
  );
}

/**
 * Proves the two things that would silently corrupt a queue: that a valid batch
 * lands on disk, and that an invalid one writes nothing at all.
 */
function triageSelfCheck() {
  const root = mkdtempSync(join(tmpdir(), 'kaizen-triage-check-'));
  const file = join(root, 'a.md');
  const original = '---\nskill: demo\ndate: 2026-01-01\nseverity: low\n---\n\n## Suggestion\n\nx\n';
  writeFileSync(file, original);

  let failed = 0;
  const assert = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failed++;
  };

  writeFrontmatter(file, { type: 'determinism', rung: '1' });
  const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'));
  assert(data.type === 'determinism' && data.rung === '1', 'a decision reaches the file');
  assert(data.severity === 'low' && data.skill === 'demo', 'existing keys survive the write');
  assert(body.includes('## Suggestion'), 'the body is left alone');

  // The guard that matters: a batch with one bad value must write nothing, or a
  // half-applied pass leaves a queue nobody planned.
  writeFileSync(file, original);
  const before = readFileSync(file, 'utf8');
  const bad = validateDecisions(
    [
      { id: 'x', type: 'determinism' },
      { id: 'x', type: 'nonsense' },
    ],
    new Map(),
  );
  assert(bad.errors.length > 0, 'an unknown vocabulary value is rejected');
  assert(readFileSync(file, 'utf8') === before, 'a rejected batch leaves every file untouched');

  rmSync(root, { recursive: true, force: true });
  if (failed) exit(1);
}

/* ---------------------------------------------------------------- asks ---- */

/** No skill ran, so asks file under a reserved name rather than inventing one. */
const ASKS_SKILL = 'session';

/**
 * The asks corpus, and the schedule that decides when to look at it.
 *
 * Three modes, because the session hook needs an exit code and a stamp before it
 * needs any output:
 *
 *   kaizen asks              # what you keep asking for, human-readable
 *   kaizen asks --json       # the same corpus, for the naming pass to read
 *   kaizen asks --due        # exit 0 when the weekly slot has been missed
 *   kaizen asks --stamp      # record that the pass ran
 *   kaizen asks --window 90  # override the window for a one-off look
 *
 * `--due` stays silent and cheap: it runs on every session start, so it reads
 * one small file and answers with a status code.
 */
function cmdAsks() {
  const { config, exists } = loadConfig();
  const enabled = exists && config.asks?.enabled === true;

  if (has('--due')) {
    if (!enabled) exit(1);
    const stamp = stampPath();
    const last = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
    exit(passDue({ weekly: config.cadence?.weekly, last }) ? 0 : 1);
  }

  if (has('--stamp')) {
    // Stamped before the pass runs, never after. A pass that dies — no `claude`
    // on PATH, no network — must not re-fire on every session until it works.
    mkdirSync(dirname(stampPath()), { recursive: true });
    writeFileSync(stampPath(), new Date().toISOString() + '\n');
    return;
  }

  if (!enabled) {
    console.error('asks is off. Enable it in Settings (asks.enabled) — it reads ~/.claude/history.jsonl.');
    exit(1);
  }

  // `--window N` overrides for a one-off look; the pass itself never passes it.
  const stamp = existsSync(stampPath()) ? readFileSync(stampPath(), 'utf8').trim() : '';
  const days = Number(flag('window')) || windowDays({ days: config.asks.days, last: stamp });
  const asks = readAsks({ days });

  if (has('--json')) {
    // What has already been filed travels *with* the corpus rather than being
    // something the pass has to remember to go and read. Dedup is the one rule
    // that, when skipped, buries the queue it exists to fill — so it does not
    // get to depend on an instruction being followed.
    const known = resolveTargets(config)
      .filter((t) => t.writable && t.feedback)
      .flatMap((t) => discoverSuggestions(t.feedback, t.name))
      .filter((s) => s.skill === ASKS_SKILL)
      .map((s) => ({ slug: s.slug, scope: s.scope, seen: s.incidents }));

    return stdout.write(JSON.stringify({ window: days, max: config.asks.max, known, asks }, null, 0));
  }

  if (asks.length === 0) return console.log('No asks in the window.');
  console.log(`${asks.length} distinct asks in the last ${days} days:\n`);
  for (const a of asks.slice(0, 30)) {
    console.log(`${String(a.n).padStart(3)}×  ${a.last}  ${a.project}  ${a.text.slice(0, 90)}`);
  }
}

/* -------------------------------------------------------------- doctor ---- */

/**
 * Kaizen's self-review, as a check rather than a checklist.
 *
 * Step 8 used to be prose a human had to remember to walk. Every defect it was
 * meant to catch was in fact caught by hand, once, by someone who happened to
 * look — which is the definition of rung 3 and exactly what this tool exists to
 * argue against. Running the rubric is now one command, and `--file` puts what
 * it finds into the same queue as everything else so it competes on score
 * instead of on whoever remembered.
 *
 *   kaizen doctor            # report
 *   kaizen doctor --file     # report, and file anything new as a suggestion
 */
function cmdDoctor() {
  const config = requireConfig();
  const state = buildState(config);
  const today = new Date().toISOString().slice(0, 10);
  const findings = runDoctor({ config, state, today });

  if (findings.length === 0) {
    console.log('kaizen doctor: nothing to report. That is a good outcome, not a failed run.');
    return;
  }

  for (const f of findings) {
    console.log(`\n[${f.severity}] ${f.slug}  (${f.check})`);
    console.log(`  scope: ${f.scope}`);
    console.log(`  ${f.context}`);
  }
  console.log(`\n${findings.length} finding(s).`);

  if (!has('--file')) {
    console.log('Re-run with --file to queue these as suggestions.');
    return;
  }

  // Kaizen files against itself into the target that owns its feedback. Without
  // one configured there is nowhere honest to put them, so say that rather than
  // inventing a path.
  const target = resolveTargets(config).find((t) => t.writable);
  if (!target) {
    console.error('No writable target configured — nowhere to file. Run `kaizen init`.');
    exit(1);
  }
  const dir = join(target.feedback, 'kaizen');
  mkdirSync(dir, { recursive: true });

  let filed = 0;
  for (const f of findings) {
    const path = join(dir, `${today}-${f.slug}.md`);
    // Re-filing the same finding every run would bury the queue it is meant to
    // clear. One file per finding per day; a recurrence is a real recurrence.
    if (existsSync(path)) continue;
    writeFileSync(path, findingToMarkdown(f, today));
    filed++;
  }
  console.log(`filed ${filed} new · ${findings.length - filed} already on disk`);
}

/* ---------------------------------------------------------------- docs ---- */

/** Where each generated artifact lands, relative to the repo root. */
const GENERATED = [['docs/LIFECYCLE.md', renderMarkdown, 'markdown']];

/**
 * Regenerate what `lifecycle.json` implies, or prove it is already current.
 *
 * The output goes through prettier before it is compared or written. Without
 * that, `npm run check` would fail on its own generated files the moment the
 * formatter disagreed with the renderer about a line break — and the fix people
 * would reach for is a `.prettierignore` entry, which puts the artifacts back
 * outside the checks.
 */
async function cmdDocs() {
  const root = join(here, '..');
  const lifecycle = loadLifecycle();

  const errors = validateLifecycle(lifecycle);
  if (errors.length) {
    console.error(`lifecycle.json is not coherent:\n  ${errors.join('\n  ')}`);
    exit(1);
  }
  if (has('--self-check')) {
    const { statuses, phases, fields } = lifecycle;
    console.log(
      `lifecycle.json is coherent · ${phases.length} phases · ` +
        `${statuses.length} statuses · ${fields.length} fields`,
    );
    return;
  }

  const prettier = await import('prettier');
  const check = has('--check');
  const stale = [];

  for (const [rel, render, parser] of GENERATED) {
    const path = join(root, rel);
    // `format` does not read .prettierrc on its own — without resolving it the
    // generator writes 80-column double-quoted output that `format:check` then
    // rejects, and the generated files fail the very check they belong to.
    const options = (await prettier.resolveConfig(path)) ?? {};
    const next = await prettier.format(render(lifecycle), { ...options, parser, filepath: path });
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (current === next) continue;
    if (check) {
      stale.push(current === null ? `${rel} (missing)` : rel);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    console.log(`wrote ${rel}`);
  }

  if (!check) return;
  if (stale.length) {
    console.error(
      `generated files are out of date:\n  ${stale.join('\n  ')}\n\nRun: node scripts/cli.mjs docs`,
    );
    exit(1);
  }
  console.log(`generated files are current (${GENERATED.map(([r]) => r).join(', ')})`);
}

/* --------------------------------------------------------------- serve ---- */

async function cmdServe() {
  const config = requireConfig();
  const { startServer } = await import('@kaizen/server');
  await startServer(config);
}

/* ----------------------------------------------------------------- tui ---- */

const TUI_BIN = join(here, '..', 'tui', 'target', 'release', 'kaizen-tui');

/**
 * A convenience alias for the binary, not a launcher.
 *
 * `kaizen-tui` starts the server itself when the port is dead — it has to, since
 * it is normally run directly off the PATH rather than through here. Repeating
 * that check in this file would be a second implementation of the same rule,
 * and the two would drift.
 */
async function cmdTui() {
  const config = requireConfig();
  const { host, port } = config.server ?? { host: '127.0.0.1', port: 7777 };

  if (!existsSync(TUI_BIN)) {
    console.error(
      `kaizen: the TUI is not built yet.\n  cd ${join(here, '..', 'tui')} && cargo build --release`,
    );
    exit(1);
  }

  const { spawn } = await import('node:child_process');
  const child = spawn(TUI_BIN, ['--base', `http://${host}:${port}`], { stdio: 'inherit' });
  await new Promise((resolve) => child.on('exit', (code) => resolve(exit(code ?? 0))));
}

/* ----------------------------------------------------------------------- */

const commands = {
  init: cmdInit,
  scan: cmdScan,
  status: cmdStatus,
  validate: cmdValidate,
  triage: cmdTriage,
  drain: cmdDrain,
  asks: cmdAsks,
  doctor: cmdDoctor,
  docs: cmdDocs,
  serve: cmdServe,
  tui: cmdTui,
  help: () =>
    console.log(
      'usage: kaizen <init|scan|status|validate|triage|drain|asks|doctor|docs|serve|tui> [--fix] [--pretty]\n' +
        '       kaizen doctor [--file]\n' +
        '       kaizen asks [--json|--due|--stamp]                # asks you keep repeating\n' +
        '       kaizen triage --apply <file.json|-> [--dry-run]\n' +
        '       kaizen triage --self-check\n' +
        '       kaizen drain --apply <file.json|-> [--dry-run]   # [{ id, sha, verified_at }]\n' +
        '       kaizen status --bar                              # 改 ○17 ●1 ◐22 ▲9, for the status line\n' +
        '       kaizen docs [--check] [--self-check]\n' +
        '       kaizen validate [--fix] [--strict]',
    ),
};

const run = commands[command];
if (!run) {
  console.error(`unknown command "${command}"`);
  commands.help();
  exit(1);
}
await run();

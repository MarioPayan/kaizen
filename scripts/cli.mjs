#!/usr/bin/env node
/**
 * kaizen — one entry point, a few subcommands. Bare, it opens the TUI.
 *
 *   init      interactive setup; discovers or asks, never assumes
 *   scan      emit the full state as JSON
 *   status    one line, for the session hook
 *   validate  check suggestion frontmatter against the schema (--fix normalises)
 *   triage    apply a batch of triage decisions to frontmatter (--self-check)
 *   verify    dry-run a planned patch and its validation in a throwaway worktree
 *   review    gather an applied card's diff and validation result at its landed SHA
 *   asks      the asks you keep repeating (--json for the weekly pass)
 *   doctor    run kaizen's own rubric against kaizen (--file queues findings)
 *   docs      regenerate what lifecycle.json implies (--check fails on drift)
 *   prune     delete closed suggestions older than a month (--dry-run)
 *   serve     start the local app + API
 *   dispatch  send a card, or the backlog, to the runners via the server
 *   tui       the queue in the terminal (starts `serve` if the port is dead)
 */
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
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
  readAsks,
  passDue,
  windowDays,
  stampPath,
  canonicalStatus,
  canTransition,
  isTerminal,
  hasLanded,
  statusLine,
  pileGlyph,
  assignBlockedBy,
  normalizeScope,
  nextStatuses,
  missingRequirements,
  section,
  writeSection,
  renderMarkdown,
  spec,
  patchIdentity,
  suggestionProject,
} from '@kaizen/core';

// Bare `kaizen` is the board: the command you reach for is the one that needs no
// name. Scripts and hooks say `status` out loud, and always did.
const [, , command = 'tui', ...args] = argv;
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
      `(${state.metrics.incidents} incidents).`,
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

/**
 * The whole state, or the slice a pass is fenced to. A targeted triage pass
 * exists to be cheap; without these it paid the full-scan cost every time to
 * find one row. Filters AND together; `metrics` stays whole-corpus so a narrowed
 * scan still says how big the queue is.
 */
function cmdScan() {
  if (has('--help')) {
    console.log('usage: kaizen scan [--pretty] [--id <exact id>] [--skill <name>] [--scope <path>]');
    return;
  }
  const state = buildState(requireConfig());
  const id = flag('id');
  const skill = flag('skill');
  const scope = flag('scope');
  if (id || skill || scope) {
    const skillsByTarget = new Map(state.targets.map((target) => [target.name, target.skills]));
    state.suggestions = state.suggestions.filter(
      (s) =>
        (!id || s.id === id) &&
        (!skill || s.skill === skill) &&
        (!scope || s.scope === normalizeScope(scope, skillsByTarget.get(s.target))),
    );
    // A fenced read is fenced on both halves. `--id` used to trim the
    // suggestions and hand back every skill on the machine anyway — the
    // first opencode run got a dump too long to show and had to re-read it
    // from a file to find the one card it asked for.
    const kept = new Set(skill ? [skill] : state.suggestions.map((s) => s.skill));
    state.skills = state.skills.filter((k) => kept.has(k.name));
  }
  stdout.write(JSON.stringify(state, null, has('--pretty') ? 2 : 0));
}

/**
 * What the session line and the status bar both count.
 *
 * One function because they are one answer rendered twice, and because they
 * drifted the moment either was edited alone — the line was still counting
 * closed files as untriaged months after the bar stopped.
 *
 * Closed is excluded from every pile. A superseded finding is history, and
 * history that greets you at the start of every session is noise you learn to
 * scroll past — which costs the line the one job it has.
 */
function piles(surfaced) {
  const open = surfaced.filter((s) => !isTerminal(s.status));
  const entry = entryStatus();
  const wants = awaitingDecision();
  return {
    toTriage: open.filter((s) => s.status === entry).length,
    // The pile at the door of the attended phase, plus every card parked on a
    // call only you can make: `blocked_on` naming something that is not another
    // open card is the board's lit flag, and `b` is the key that answers it.
    // Those cards were invisible here — a `triaged` row waiting on you for a
    // week reported as nothing at all. A card still wearing `needs_review` is
    // not yours yet whatever its status: the reviewer has it.
    awaitingYou: open.filter(
      (s) => (wants.includes(s.status) && !s.needsReview) || (s.blockedOn && !s.blockedBy),
    ).length,
    landed: open.filter((s) => hasLanded(s.status)).length,
    // A card whose commit is in is addressed, pending verification — it is the
    // `landed` pile's business, not evidence the skill is still costing you.
    top: hottestSkill(open.filter((s) => !hasLanded(s.status))),
  };
}

/**
 * The busiest skill still holding open work — the bar's ▲ and the line's
 * "top". Grouping is the skill itself now (`session` included), so this is a
 * count, not a clustering pass.
 *
 * Incidents are counted on open cards only. Counting the whole history is what
 * had every session announcing `top: kaizen (94)` when 71 of those incidents
 * were closed and 23 were the actual queue.
 */
// ponytail: 5 open incidents, where it used to be 5 lifetime ones — a floor,
// not a knob. Nobody has ever turned it.
function hottestSkill(open) {
  const bySkill = new Map();
  for (const s of open) bySkill.set(s.skill, (bySkill.get(s.skill) ?? 0) + s.incidents);
  const top = [...bySkill.entries()].filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1])[0];
  return top ? { skill: top[0], incidents: top[1] } : null;
}

/**
 * Every suggestion the user asked to see, without a full scan.
 *
 * The bar redraws on a timer, so it reads suggestions only — no skills
 * discovery, no project scan, no git. `blockedBy` is the one derivation it
 * cannot skip: without it a card parked on another card reads as parked on you.
 */
function surfacedSuggestions(config) {
  const suggestions = [];
  const seen = new Set();
  for (const t of resolveTargets(config)) {
    if (!t.feedback || seen.has(t.feedback)) continue;
    seen.add(t.feedback);
    suggestions.push(...discoverSuggestions(t.feedback, t.name));
  }
  assignBlockedBy(suggestions);
  const surface = surfaceOf(config);
  return suggestions.filter((s) => passesSurface(s, surface));
}

/**
 * The status bar segment — concept A of the 2026-08-09 proposals: pile shapes.
 *
 *   改 ○17 ●1 ◐22 ▲9
 *
 * The glyphs and what each one means are spec data (`statusLine` in
 * lifecycle.json), so the TUI's guide explains exactly what this paints. Zero
 * segments vanish; an empty backlog is a dim mark, which proves the segment is
 * alive without saying anything.
 *
 * It never errors out loud: a bar that prints a stack trace every few seconds
 * is worse than no bar.
 */
function cmdBar() {
  const paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
  try {
    const { config, exists, errors } = loadConfig();
    if (!exists || errors.length) return;

    const p = piles(surfacedSuggestions(config));
    const mark = statusLine().mark;
    const parts = [];
    if (p.toTriage) parts.push(paint('36', `${pileGlyph('triage')}${p.toTriage}`));
    if (p.awaitingYou) parts.push(paint('1;33', `${pileGlyph('decide')}${p.awaitingYou}`));
    if (p.landed) parts.push(paint('34', `${pileGlyph('landed')}${p.landed}`));
    if (p.top) parts.push(paint('31', `${pileGlyph('hottest')}${p.top.incidents}`));

    if (parts.length === 0) return console.log(paint('2', mark));
    console.log(`${paint('36', mark)} ${parts.join(' ')}`);
  } catch {
    /* silence — the bar has no business breaking a prompt */
  }
}

/**
 * The session hook calls this. It must stay cheap and quiet: one line, no model,
 * and silence when there is genuinely nothing to say.
 */
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

  // Counted over what the user asked to see, not over everything on disk. The
  // dashboard's header still reports the full totals; this line is the one that
  // interrupts, so it obeys the filter.
  const p = piles(state.suggestions.filter((s) => s.surfaced));

  // The two piles a person can do something about, named in the spec's words so
  // the line, the bar's glyphs and the TUI's legend cannot disagree. `landed` is
  // deliberately not here: it waits on the verify phase, and a session line that
  // reports what needs nothing from anyone is the noise this line already had
  // once. There used to be an `untriaged` segment too — labels missing, rather
  // than a judgement missing — which after excluding closed files is the same
  // cards as `to triage`, counted twice with two different words.
  const label = (id) => statusLine().piles.find((x) => x.id === id)?.label ?? id;
  const parts = [];
  if (p.toTriage) parts.push(`${p.toTriage} ${label('triage')}`);
  if (p.awaitingYou) parts.push(`${p.awaitingYou} ${label('decide')}`);
  if (p.top) parts.push(`top: ${p.top.skill} (${p.top.incidents})`);
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
      hasPatch: !!s.patch,
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
  // The triage phase's own output: which commit the problem was last confirmed
  // to still exist at. Without it a pass cannot legally reach `triaged`, and the
  // 27 already-fixed suggestions this check exists for stay invisible.
  confirmed_at: null,
  // Why an item is parked short of the next phase, when the reason is a
  // decision only the user can make. One line; empty clears it.
  blocked_on: null,
  // Who has to check a status before the card is where it says. The runner
  // writes the reviewer's name in the same call as the status; the reviewer
  // clears it with an empty value once the work holds up.
  needs_review: null,
  // Remapping an orphan onto its successor is a triage decision, and the
  // edge-case list already calls for it. The folder is the scanner's signal, so
  // a remap is a move plus this field.
  skill: null,
  // The verify phase's own output: when the validation plan ran and what it
  // returned. Without this key the unattended verify pass had no mechanical
  // writer and Step 7 forced the hand-editing the skill forbids.
  verified_at: null,
};

/**
 * A phase's output can live in the body rather than the frontmatter: `## Plan`
 * and `## Validation` for plan, `## Review` for review, `## Verdict` for a
 * check — every body field the spec declares, keyed by id, valued by heading.
 * Without a writer for them the "write the whole pass in one call" rule held for
 * triage and verify and was silently false for plan — every pass rediscovered
 * `cat >>` by reading source. Free text; the section is replaced if the heading
 * exists and appended otherwise.
 */
const LIFECYCLE = spec();
const BODY_FIELDS = Object.fromEntries(
  LIFECYCLE.fields.filter((f) => f.where === 'body').map((f) => [f.id, f]),
);
const PHASES = new Map(LIFECYCLE.phases.map((p) => [p.id, p]));
const STATUS_PHASES = new Map(LIFECYCLE.statuses.map((s) => [s.id, PHASES.get(s.phase)]));

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
    const sections = {};
    for (const [key, value] of Object.entries(d)) {
      if (key === 'id') continue;
      if (key in BODY_FIELDS) {
        if (!String(value).trim()) {
          errors.push(`${where}.${key}: must not be empty`);
          continue;
        }
        sections[BODY_FIELDS[key].heading] = String(value);
        continue;
      }
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
      // Two fields have an empty value that is itself a decision: `blocked_on`
      // is the parking reason, cleared once the call is made (Step 5), and
      // `needs_review` is the reviewer's name, cleared once the check passed.
      // Every other free-text field arriving empty is a mistake.
      if (!allowed && !text.trim() && key !== 'blocked_on' && key !== 'needs_review') {
        errors.push(`${where}.${key}: must not be empty`);
        continue;
      }
      patch[key] = text;
    }
    const lifecycle = spec();
    const decision = lifecycle.phases.find((p) => p.attended);
    const prior = lifecycle.statuses.find((s) => (s.next ?? []).includes(decision?.produces));
    const reviewer = lifecycle.phases.find((p) => p.produces === prior?.id)?.reviewer;
    if (found.status === decision?.produces) {
      const sidecar = found.file.replace(/\.md$/, '.patch');
      const identity = existsSync(sidecar) ? patchIdentity(readFileSync(sidecar)) : '';
      if (found.approvedPatch !== identity) {
        if (patch.status !== prior?.id || patch.needs_review !== reviewer) {
          errors.push(
            `${where}: the approved patch changed; return it to "${prior?.id}" with needs_review "${reviewer}"`,
          );
        } else {
          patch.approved_patch = '';
        }
      }
    }
    if (Object.keys(patch).length || Object.keys(sections).length) {
      writes.push({ file: found.file, id: found.id, patch, sections });
    }
  }
  return { errors, writes };
}

/** One decision's writes, frontmatter then body, on one file. */
function applyWrite(w) {
  const statusPhase = STATUS_PHASES.get(canonicalStatus(w.patch.status));
  const refreshedBody = Object.keys(w.sections ?? {}).some((heading) => {
    const field = Object.values(BODY_FIELDS).find((f) => f.heading === heading);
    return field.id !== 'verdict' && PHASES.get(field.phase)?.reviewer;
  });
  const invalidatesVerdict = statusPhase?.reviewer || refreshedBody;
  if (Object.keys(w.patch).length || invalidatesVerdict) {
    writeFrontmatter(w.file, w.patch, {
      removeSections: invalidatesVerdict ? [BODY_FIELDS.verdict.heading] : [],
    });
  }
  for (const [heading, text] of Object.entries(w.sections ?? {})) writeSection(w.file, heading, text);
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
  const state = buildState(config);
  const byId = new Map(state.suggestions.map((s) => [s.id, s]));
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
    const hasPatch = !!found.patch;
    const decisionStatus = spec().phases.find((p) => p.attended)?.produces;
    if ((found.status === decisionStatus || path.includes(decisionStatus)) && hasPatch) {
      const identity = patchIdentity(readFileSync(found.patch));
      if (merged.approved_patch !== identity) {
        errors.push(`${where}: cannot pass "${decisionStatus}" — approved patch identity does not match`);
      }
    }
    for (const step of path) {
      for (const f of missingRequirements(step, { data: merged, body, hasPatch })) {
        errors.push(`${where}: cannot pass "${step}" — missing ${f}`);
      }
    }
    writes.push({
      file: found.file,
      patch: { status: 'verified', applied_sha: e.sha, verified_at: e.verified_at },
    });
    for (const member of state.suggestions) {
      if (member.blockedBy !== found.id || !canTransition(member.status, 'superseded')) continue;
      writes.push({ file: member.file, patch: { status: 'superseded', superseded_by: e.sha } });
    }
  }

  if (errors.length) {
    console.error(`refusing to write — ${errors.length} problem(s):\n  ${errors.join('\n  ')}`);
    exit(1);
  }
  const dry = has('--dry-run');
  for (const w of writes) if (!dry) writeFrontmatter(w.file, w.patch);
  console.log(`${dry ? 'would stamp' : 'stamped'} ${writes.length} suggestion(s) verified`);
}

/* -------------------------------------------------------------- verify ---- */

const dependencyInstalls = [
  {
    lockfiles: ['bun.lock', 'bun.lockb'],
    command: 'bun',
    args: ['install', '--frozen-lockfile', '--ignore-scripts'],
  },
  {
    lockfiles: ['pnpm-lock.yaml'],
    command: 'pnpm',
    args: ['install', '--frozen-lockfile', '--ignore-scripts'],
  },
  { lockfiles: ['yarn.lock'], command: 'yarn', args: ['install', '--immutable', '--mode=skip-build'] },
  {
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
    command: 'npm',
    args: ['ci', '--ignore-scripts'],
  },
];

/** Prepare a clean verification worktree without running dependency lifecycle scripts. */
function installDependencies(worktree) {
  const install = dependencyInstalls.find(({ lockfiles }) =>
    lockfiles.some((file) => existsSync(join(worktree, file))),
  );
  if (install) execFileSync(install.command, install.args, { cwd: worktree, stdio: 'inherit' });
}

/** Run a planned patch and its validation without touching the target tree. */
function cmdVerify() {
  const id = args.find((a) => !a.startsWith('--'));
  if (!has('--dry') || !id) {
    console.error('usage: kaizen verify --dry <suggestion id>');
    exit(1);
  }

  const config = requireConfig();
  const state = buildState(config);
  const found = state.suggestions.find((s) => s.id === id);
  if (!found) {
    console.error(`no suggestion with id "${id}"`);
    exit(1);
  }
  if (found.status !== 'planned') {
    console.error(`refusing to verify "${id}" at status "${found.status}"; expected planned`);
    exit(1);
  }

  const target = resolveTargets(config).find((t) => t.name === found.target);
  const patch = found.patch;
  if (!target || !patch) {
    console.error(
      `refusing to verify "${id}"; ${target ? 'proposal patch is missing' : 'target is missing'}`,
    );
    exit(1);
  }

  const parsed = parseFrontmatter(readFileSync(found.file, 'utf8'));
  const validation = section(parsed.body, 'Validation');
  const fenced = /```bash\s*\r?\n([\s\S]*?)\r?\n```/m.exec(validation)?.[1];
  if (!fenced) {
    console.error(`refusing to verify "${id}"; Validation has no fenced bash block`);
    exit(1);
  }

  const parent = mkdtempSync(join(tmpdir(), 'kaizen-verify-'));
  const worktree = join(parent, 'worktree');
  let repo;
  let added = false;
  let failure = '';
  try {
    const project = suggestionProject(state, found);
    repo = execFileSync('git', ['-C', project ?? target.skills, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', worktree, 'HEAD']);
    added = true;

    execFileSync('git', ['-C', worktree, 'apply', patch]);
    installDependencies(worktree);

    const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const repoPattern = new RegExp(`${escapedRepo}(?=$|/|[\\s"'\\x60;&|<>()])`, 'g');
    const command = fenced.replace(repoPattern, worktree);
    const writeValidationOutput = (result) => {
      if (result.stdout) {
        for (const line of result.stdout.trimEnd().split(/\r?\n/)) {
          process.stdout.write(`[validation stdout] ${line}\n`);
        }
      }
      if (result.stderr) {
        for (const line of result.stderr.trimEnd().split(/\r?\n/)) {
          process.stderr.write(`[validation stderr] ${line}\n`);
        }
      }
    };
    const ran = spawnSync('bash', ['-lec', command], {
      cwd: worktree,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: worktree, KAIZEN_TARGET_ROOT: worktree },
    });
    writeValidationOutput(ran);
    if (ran.status !== 0) {
      if (!ran.stdout && !ran.stderr) {
        const traced = spawnSync('bash', ['-lec', `set -x\n${command}`], {
          cwd: worktree,
          encoding: 'utf8',
          env: { ...process.env, CLAUDE_PLUGIN_ROOT: worktree, KAIZEN_TARGET_ROOT: worktree },
        });
        writeValidationOutput(traced);
      }
      failure = `fail ${id} (exit ${ran.status ?? 'unknown'})`;
    }
  } catch (e) {
    failure = `fail ${id}: ${e.message}`;
  } finally {
    if (added) {
      try {
        execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktree]);
      } catch {
        // The parent removal below is best-effort cleanup for a failed worktree command.
      }
    }
    rmSync(parent, { recursive: true, force: true });
  }
  if (failure) {
    console.error(`── verify verdict ──\n${failure}`);
    exit(1);
  }
  console.log(`── verify verdict ──\npass ${id}`);
}

/* -------------------------------------------------------------- review ---- */

/** Gather the fixed evidence for an applied-card review at the commit that landed. */
function cmdReview() {
  const id = args.find((a) => !a.startsWith('--'));
  if (!has('--dry') || !id) {
    console.error('usage: kaizen review --dry <suggestion id>');
    exit(1);
  }

  const config = requireConfig();
  const found = buildState(config).suggestions.find((s) => s.id === id);
  if (!found) {
    console.error(`no suggestion with id "${id}"`);
    exit(1);
  }
  if (found.status !== 'applied') {
    console.error(`refusing to review "${id}" at status "${found.status}"; expected applied`);
    exit(1);
  }

  const target = resolveTargets(config).find((t) => t.name === found.target);
  if (!target || !found.appliedSha) {
    console.error(`refusing to review "${id}"; ${target ? 'applied SHA is missing' : 'target is missing'}`);
    exit(1);
  }

  const parsed = parseFrontmatter(readFileSync(found.file, 'utf8'));
  const validation = section(parsed.body, 'Validation');
  const fenced = /```bash\s*\r?\n([\s\S]*?)\r?\n```/m.exec(validation)?.[1];
  if (!fenced) {
    console.error(`refusing to review "${id}"; Validation has no fenced bash block`);
    exit(1);
  }

  const parent = mkdtempSync(join(tmpdir(), 'kaizen-review-'));
  const worktree = join(parent, 'worktree');
  let repo;
  let added = false;
  let result;
  let failure = '';
  try {
    repo = execFileSync('git', ['-C', target.skills, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    const sha = execFileSync('git', ['-C', repo, 'rev-parse', `${found.appliedSha}^{commit}`], {
      encoding: 'utf8',
    }).trim();
    const diff = execFileSync('git', ['-C', repo, 'show', '--format=fuller', '--no-ext-diff', sha], {
      encoding: 'utf8',
    });
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', worktree, sha]);
    added = true;

    const pkg = join(worktree, 'package.json');
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === 'kaizen') {
      execFileSync('npm', ['ci', '--ignore-scripts'], { cwd: worktree, stdio: 'ignore' });
    }

    const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const repoPattern = new RegExp(`${escapedRepo}(?=$|/|[\\s"'\\x60;&|<>()])`, 'g');
    const validationCommand = fenced.replace(repoPattern, worktree);
    const ran = spawnSync('bash', ['-lc', validationCommand], {
      cwd: worktree,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: worktree, KAIZEN_TARGET_ROOT: worktree },
    });
    result = {
      id,
      sha,
      diff,
      validation: {
        command: fenced,
        exitCode: ran.status,
        stdout: ran.stdout,
        stderr: ran.stderr,
      },
    };
  } catch (e) {
    failure = `failed to gather review evidence for "${id}": ${e.message}`;
  } finally {
    if (added) {
      try {
        execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktree]);
      } catch {
        // The parent removal below is best-effort cleanup for a failed worktree command.
      }
    }
    rmSync(parent, { recursive: true, force: true });
  }

  if (failure) {
    console.error(failure);
    exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.validation.exitCode !== 0) exit(1);
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

  for (const w of writes) if (!dry) applyWrite(w);

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
  const original =
    '---\nskill: demo\ndate: 2026-01-01\nseverity: low\n---\n\n## Suggestion\n\nx\n\n## Verdict\n\npass — old plan\n';
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

  // Clearing a parked item is a write, not an error: `blocked_on: ""` must land
  // as an empty value while every other empty free-text field is still refused.
  writeFrontmatter(file, { blocked_on: 'waiting on a call only Mario can make' });
  const byId = new Map([['a', { id: 'a', file }]]);
  const cleared = validateDecisions([{ id: 'a', blocked_on: '' }], byId);
  assert(
    cleared.errors.length === 0 && cleared.writes.length === 1,
    'an empty blocked_on is accepted as a clear',
  );
  for (const w of cleared.writes) writeFrontmatter(w.file, w.patch);
  assert(
    parseFrontmatter(readFileSync(file, 'utf8')).data.blocked_on === '',
    'a cleared blocked_on lands empty on disk',
  );
  assert(
    validateDecisions([{ id: 'a', scope: '' }], byId).errors.length === 1,
    'an empty scope is still refused',
  );

  // The plan phase writes body sections, through the same call and the same
  // all-or-nothing gate: a heading is appended when absent, replaced in place
  // when present, and the frontmatter and the other sections survive both.
  writeFileSync(file, original);
  const planned = validateDecisions(
    [{ id: 'a', status: 'planned', plan: 'edit X', validation: 'run Y\n\nexit 0 passes' }],
    byId,
  );
  assert(planned.errors.length === 0 && planned.writes.length === 1, 'plan and validation are accepted');
  for (const w of planned.writes) applyWrite(w);
  let parsed = parseFrontmatter(readFileSync(file, 'utf8'));
  assert(
    parsed.data.status === 'planned' && parsed.data.skill === 'demo',
    'the frontmatter write rides along',
  );
  assert(
    section(parsed.body, 'Plan') === 'edit X' &&
      section(parsed.body, 'Validation') === 'run Y\n\nexit 0 passes',
    'absent sections are appended with their content',
  );
  assert(section(parsed.body, 'Verdict') === '', 'planning clears a verdict about the previous state');
  assert(section(parsed.body, 'Suggestion') === 'x', 'existing sections survive the append');
  for (const w of validateDecisions([{ id: 'a', plan: 'edit Z' }], byId).writes) applyWrite(w);
  parsed = parseFrontmatter(readFileSync(file, 'utf8'));
  assert(
    section(parsed.body, 'Plan') === 'edit Z' &&
      section(parsed.body, 'Validation') === 'run Y\n\nexit 0 passes',
    'a present section is replaced in place, its neighbours untouched',
  );
  assert(validateDecisions([{ id: 'a', plan: '  ' }], byId).errors.length === 1, 'an empty plan is refused');

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
/**
 * The earlier filing a doctor finding belongs to, if any. Open under any date
 * is the same finding; so is one that was rejected — a "no" is an answer, and
 * re-filing it daily until the check itself is fixed is how three duplicates
 * of one root cause got into the corpus. Superseded is not: the problem came
 * back, and that is news. Open wins over rejected when both exist, so the
 * recurrence lands on the file someone is still working.
 */
function priorFiling(suggestions, slug) {
  const same = suggestions.filter((s) => s.skill === 'kaizen' && s.slug === slug);
  return (
    same.find((s) => !isTerminal(s.status) && !hasLanded(s.status)) ??
    same.find((s) => canonicalStatus(s.status) === 'rejected') ??
    null
  );
}

function doctorSelfCheck() {
  let failed = 0;
  const assert = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failed++;
  };
  const row = (status, slug = 'x') => ({ skill: 'kaizen', slug, status });
  assert(priorFiling([row('recorded')], 'x')?.status === 'recorded', 'an open filing absorbs the recurrence');
  assert(priorFiling([row('rejected')], 'x')?.status === 'rejected', 'a rejected filing absorbs it too');
  assert(priorFiling([row('superseded')], 'x') === null, 'a superseded one does not — a comeback is news');
  assert(priorFiling([row('verified')], 'x') === null, 'nor does a landed one');
  assert(
    priorFiling([row('rejected'), row('triaged')], 'x')?.status === 'triaged',
    'open wins over rejected when both exist',
  );
  assert(priorFiling([row('recorded', 'y')], 'x') === null, 'a different slug is a different finding');
  if (failed) exit(1);
}

function cmdDoctor() {
  if (has('--self-check')) return doctorSelfCheck();
  const config = requireConfig();
  const state = buildState(config);
  // Local date, not toISOString(): an evening run must not stamp files with
  // tomorrow's UTC date.
  const today = new Date().toLocaleDateString('sv');
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
  let recurred = 0;
  for (const f of findings) {
    // The same finding under any earlier date — open, or already rejected — is
    // the same finding; a second file would bury the queue this exists to
    // clear. A recurrence section keeps the receipt without the burial, once
    // per day.
    const prior = priorFiling(state.suggestions, f.slug);
    if (prior) {
      const marker = `## Recurrence — ${today}`;
      if (!readFileSync(prior.file, 'utf8').includes(marker)) {
        appendFileSync(prior.file, `\n${marker}\n\nRe-fired by \`kaizen doctor\`.\n`);
      }
      recurred++;
      continue;
    }
    writeFileSync(join(dir, `${today}-${f.slug}.md`), findingToMarkdown(f, today));
    filed++;
  }
  console.log(`filed ${filed} new · ${recurred} recurrence(s) on open findings`);
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

/* --------------------------------------------------------------- prune ---- */

/**
 * The corpus is the registry: uids are handed out across it, the closed lane
 * draws all of it, and a scan reads every file. So it is kept small on
 * purpose — a closed suggestion from more than a month ago is history, and
 * `git log --grep=Kaizen-Suggestion` is where the history that matters lives.
 * "Closed" is the spec's terminal set; "more than a month ago" is the board's
 * own `older` bucket, by the filed date — the same line the board draws, so
 * what prune takes is exactly what sat under it in the closed lane.
 */
async function cmdPrune() {
  const dry = has('--dry-run');
  const state = buildState(requireConfig());
  const stale = state.suggestions.filter((s) => isTerminal(s.status) && s.age === 'older');
  for (const s of stale) {
    if (!dry) rmSync(s.file, { force: true });
    if (!dry) rmSync(s.file.replace(/\.md$/, '.patch'), { force: true });
    console.log(`${dry ? 'would prune' : 'pruned'}  ${s.status.padEnd(10)} ${s.id}`);
  }
  console.log(`${dry ? 'would prune' : 'pruned'} ${stale.length} closed suggestion(s) older than a month`);
}

/* --------------------------------------------------------------- serve ---- */

async function cmdServe() {
  const config = requireConfig();
  const { startServer } = await import('@kaizen/server');
  await startServer(config);
}

/* ------------------------------------------------------------ dispatch ---- */

/**
 * Hand a card, or the backlog, to the server's seats — the same request `a`
 * and `A` make from the board, for a shell or a Claude session that has no
 * board open. The server picks the runner from the card (opencode does, claude
 * checks) and chains the check after the work, so one call is the whole
 * unattended stretch.
 *
 * Goes through the server rather than spawning here: the seats, the line and
 * the chain live there, and a second launcher would be a second queue.
 *
 *   kaizen dispatch                  # the backlog
 *   kaizen dispatch <suggestion id>  # one card
 */
async function cmdDispatch() {
  const config = requireConfig();
  const { host, port } = config.server ?? { host: '127.0.0.1', port: 7777 };
  const id = args.find((a) => !a.startsWith('--')) ?? null;
  let res;
  try {
    res = await fetch(`http://${host}:${port}/api/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(id ? { id } : {}),
    });
  } catch {
    // Not started here on purpose: the TUI already knows how to start the
    // server, and a second implementation of that rule would drift from it.
    console.error(
      `cannot reach the kaizen server at http://${host}:${port} — start it: kaizen serve, ` +
        'from a terminal of your own (a server started inside a Claude session dies with it; ' +
        '`systemd-run --user --unit=kaizen-serve` keeps one alive)',
    );
    exit(1);
  }
  const body = await res.json();
  if (!res.ok) {
    console.error(body.error ?? `server said ${res.status}`);
    exit(1);
  }
  const what = id ? id.split('/').at(-1) : 'the backlog';
  if (body.queued) console.log(`${what}: in line, place ${body.queued} (${body.pending} pending)`);
  else console.log(`${what}: started as pid ${body.pid} (${body.pending} pending)`);
}

/* ----------------------------------------------------------------- tui ---- */

const TUI_BIN = join(here, '..', 'tui', 'target', 'release', 'kaizen-tui');

/**
 * The front door — bare `kaizen` lands here — but a launcher only.
 *
 * `kaizen-tui` starts the server itself when the port is dead, so this does not
 * check the port: that would be a second implementation of the same rule, and
 * the two would drift.
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
  verify: cmdVerify,
  review: cmdReview,
  drain: cmdDrain,
  asks: cmdAsks,
  doctor: cmdDoctor,
  docs: cmdDocs,
  prune: cmdPrune,
  serve: cmdServe,
  dispatch: cmdDispatch,
  tui: cmdTui,
  help: () =>
    console.log(
      'usage: kaizen                                            # the board, in the terminal\n' +
        '       kaizen <init|scan|status|validate|triage|verify|review|drain|asks|doctor|docs|prune|serve|dispatch|tui> [--fix] [--pretty]\n' +
        '       kaizen dispatch [<suggestion id>]                 # send a card, or the backlog, to the runners\n' +
        '       kaizen doctor [--file]\n' +
        '       kaizen asks [--json|--due|--stamp]                # asks you keep repeating\n' +
        '       kaizen triage --apply <file.json|-> [--dry-run]\n' +
        '       kaizen triage --self-check\n' +
        '       kaizen verify --dry <suggestion id>               # apply patch + run fenced bash validation\n' +
        '       kaizen review --dry <suggestion id>               # landed diff + validation result as JSON\n' +
        '       kaizen drain --apply <file.json|-> [--dry-run]   # [{ id, sha, verified_at }]\n' +
        '       kaizen status --bar                              # 改 ○17 ●1 ◐22 ▲9, for the status line\n' +
        '       kaizen docs [--check] [--self-check]\n' +
        '       kaizen prune [--dry-run]                         # closed and older than a month\n' +
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

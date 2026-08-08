#!/usr/bin/env node
/**
 * kaizen — one entry point, a few subcommands.
 *
 *   init      interactive setup; discovers or asks, never assumes
 *   scan      emit the full state as JSON
 *   status    one line, for the session hook
 *   validate  check suggestion frontmatter against the schema (--fix normalises)
 *   serve     start the local app + API
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
} from '@kaizen/core';

const [, , command = 'status', ...args] = argv;
const has = (flag) => args.includes(flag);

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
      `(${state.metrics.incidents} incidents, ${state.metrics.clusters} clusters).`,
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
function cmdStatus() {
  const { config, exists, errors } = loadConfig();
  if (!exists) return;
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
  const { metrics, clusters } = state;
  if (metrics.total === 0) return;

  const parts = [];
  if (metrics.untriaged) parts.push(`${metrics.untriaged} untriaged`);
  const ready = state.suggestions.filter((s) => s.status === 'proposed' || s.status === 'approved').length;
  if (ready) parts.push(`${ready} awaiting you`);
  const top = clusters.find((c) => c.promoted);
  if (top) parts.push(`top: ${top.id} (${top.incidents})`);
  if (parts.length === 0) return;
  console.log(`kaizen: ${parts.join(' · ')}`);
}

/* ------------------------------------------------------------ validate ---- */

const REQUIRED = ['skill', 'date', 'severity'];

function cmdValidate() {
  const config = requireConfig();
  const state = buildState(config);
  const fix = has('--fix');
  let problems = 0;
  let fixed = 0;

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
      if (!data.status) patch.status = 'new';
      if (Object.keys(patch).length) {
        writeFrontmatter(s.file, patch);
        fixed++;
      }
    }
    if (issues.length) {
      problems++;
      console.log(`${s.id}\n  ${issues.join('\n  ')}`);
    }
  }

  console.log(
    `\n${state.suggestions.length} files · ${problems} with problems` +
      (fix ? ` · ${fixed} normalised` : '') +
      `\n${state.metrics.untriaged} untriaged (missing taxonomy — that is triage work, not a schema error)`,
  );
  if (problems && !fix) exit(1);
}

/* --------------------------------------------------------------- serve ---- */

async function cmdServe() {
  const config = requireConfig();
  const { startServer } = await import('@kaizen/server');
  await startServer(config);
}

/* ----------------------------------------------------------------------- */

const commands = {
  init: cmdInit,
  scan: cmdScan,
  status: cmdStatus,
  validate: cmdValidate,
  serve: cmdServe,
  help: () => console.log('usage: kaizen <init|scan|status|validate|serve> [--fix] [--pretty]'),
};

const run = commands[command];
if (!run) {
  console.error(`unknown command "${command}"`);
  commands.help();
  exit(1);
}
await run();

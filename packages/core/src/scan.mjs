/**
 * Reading the world: what skills exist, what they have filed, and how the two relate.
 *
 * Everything here reads in place. Skills are never copied into kaizen — a skill
 * edited in an editor is current the next time this runs, and there is no second
 * copy to drift.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ageOf, assignUids, localToday, parseSuggestion } from './suggestion.mjs';
import { resolveTargets, expandPath } from './config.mjs';
import { surfaceOf, passesSurface } from './taxonomy.mjs';
import { suggestionId } from './paths.mjs';
import { isTerminal } from './lifecycle.mjs';

const SCRIPT_EXT = /\.(sh|py|mjs|js|ts|bash|zsh)$/i;

function safeReaddir(dir, opts) {
  try {
    return readdirSync(dir, opts);
  } catch {
    return [];
  }
}

function countLines(file) {
  try {
    const text = readFileSync(file, 'utf8');
    return text.length === 0 ? 0 : text.split('\n').length;
  } catch {
    return 0;
  }
}

/** Walk a skill directory, counting prose against deterministic assets. */
function inspectSkillDir(dir) {
  let scripts = 0;
  const walk = (d, depth) => {
    if (depth > 3) return;
    for (const entry of safeReaddir(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (SCRIPT_EXT.test(entry.name)) scripts++;
    }
  };
  walk(dir, 0);
  return { scripts };
}

/**
 * A skills directory holds one folder per skill (each with SKILL.md), plus
 * optional shared modules under `_lib`. Library modules carry no frontmatter by
 * design, so they are catalogued separately rather than treated as skills.
 */
export function discoverSkills(skillsDir, { target = '', kind = 'user' } = {}) {
  const out = [];
  if (!existsSync(skillsDir)) return out;

  for (const entry of safeReaddir(skillsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const dir = join(skillsDir, entry.name);
    const isDir = entry.isDirectory() || entry.isSymbolicLink();
    if (!isDir) continue;

    if (entry.name === '_lib') {
      const walkLib = (d) => {
        for (const e of safeReaddir(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) walkLib(full);
          else if (e.name.endsWith('.md')) {
            out.push({
              name: relative(skillsDir, full),
              kind: 'library',
              target,
              path: full,
              lines: countLines(full),
              scripts: 0,
            });
          }
        }
      };
      walkLib(dir);
      continue;
    }

    const skillFile = join(dir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    out.push({
      name: entry.name,
      kind,
      target,
      path: skillFile,
      dir,
      lines: countLines(skillFile),
      scripts: inspectSkillDir(dir).scripts,
    });
  }
  return out.sort((a, b) => b.lines - a.lines);
}

/**
 * Identify the repository a directory belongs to, collapsing git worktrees.
 *
 * In a worktree `--git-dir` points at `<main>/.git/worktrees/<name>` while
 * `--git-common-dir` points at the shared `<main>/.git`. Comparing them is how
 * git itself distinguishes the two, so it is exact rather than a name heuristic.
 *
 * This matters a lot in practice: a repo with 24 active worktrees presents the
 * same ten skills 24 times, and without collapsing them the inventory is almost
 * entirely duplicates.
 */
const repoCache = new Map();

function repoIdentity(dir) {
  if (repoCache.has(dir)) return repoCache.get(dir);
  let identity = { repo: dir, isWorktree: false };
  try {
    const common = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    if (common) {
      identity = { repo: dirname(common), isWorktree: resolve(common) !== resolve(dir, '.git') };
    }
  } catch {
    /* not a git repo — treat the directory as its own identity */
  }
  repoCache.set(dir, identity);
  return identity;
}

/**
 * Bounded, opt-in discovery of project-level `.claude/skills`.
 *
 * Depth-limited because walking a repo root blindly is slow, and worktree-aware
 * because otherwise it is mostly slow for nothing.
 */
export function discoverProjectSkills({ roots = [], depth = 3 } = {}) {
  const out = [];
  const seenDirs = new Set();
  const seenSkills = new Set();
  const worktreeCount = new Map();

  const walk = (dir, level) => {
    if (level > depth) return;
    const candidate = join(dir, '.claude', 'skills');
    if (existsSync(candidate) && !seenDirs.has(candidate)) {
      seenDirs.add(candidate);
      const { repo, isWorktree } = repoIdentity(dir);
      if (isWorktree) worktreeCount.set(repo, (worktreeCount.get(repo) ?? 0) + 1);

      for (const skill of discoverSkills(candidate, { target: `project:${repo}`, kind: 'project' })) {
        // One entry per skill per repository. A worktree holds the same file,
        // and listing it again says nothing new.
        const key = `${repo}::${skill.name}`;
        if (seenSkills.has(key)) continue;
        seenSkills.add(key);
        out.push({ ...skill, project: repo, foundIn: dir });
      }
    }
    for (const entry of safeReaddir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      walk(join(dir, entry.name), level + 1);
    }
  };

  for (const root of roots) {
    const abs = expandPath(root);
    try {
      if (statSync(abs).isDirectory()) walk(abs, 1);
    } catch {
      /* configured root does not exist — reported by the caller, not fatal */
    }
  }

  return out.map((s) => ({ ...s, worktrees: worktreeCount.get(s.project) ?? 0 }));
}

/** Read every suggestion filed under a feedback directory. */
export function discoverSuggestions(feedbackDir, targetName) {
  const out = [];
  if (!existsSync(feedbackDir)) return out;

  for (const entry of safeReaddir(feedbackDir, { withFileTypes: true })) {
    // `_`-prefixed is "not a skill", the same convention `_lib` already uses in
    // a skills tree. It is what makes the documented `_archive/` escape hatch
    // work: without it, archiving an orphan just renames the orphan to
    // `_archive` and the warning never clears.
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const skillDir = join(feedbackDir, entry.name);
    for (const file of safeReaddir(skillDir)) {
      if (!file.endsWith('.md')) continue;
      const full = join(skillDir, file);
      let text;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      out.push(
        parseSuggestion({
          id: suggestionId(targetName, entry.name, file),
          file: full,
          skill: entry.name,
          target: targetName,
          text,
        }),
      );
    }
  }
  return out;
}

/** Build the complete state the app and the skill both read. */
export function buildState(config) {
  const targets = resolveTargets(config);
  const skills = [];
  const suggestions = [];
  const warnings = [];

  // Two targets may legitimately name the same feedback directory (or the same
  // skills tree via different paths). Counting a file twice would inflate every
  // number the dashboard shows, so the first target to claim a path keeps it.
  const seenFeedback = new Set();
  const seenSkillFiles = new Set();

  for (const t of targets) {
    if (!existsSync(t.skills)) warnings.push(`target "${t.name}": skills path not found — ${t.skills}`);
    if (t.feedback && !existsSync(t.feedback)) {
      warnings.push(`target "${t.name}": feedback path not found — ${t.feedback}`);
    }

    for (const skill of discoverSkills(t.skills, { target: t.name })) {
      if (seenSkillFiles.has(skill.path)) continue;
      seenSkillFiles.add(skill.path);
      skills.push(skill);
    }

    // Discovery-only: the target contributes skills to the inventory and
    // nothing else, which is exactly what stops their feedback folders
    // elsewhere from reading as orphans.
    if (!t.feedback) continue;
    if (seenFeedback.has(t.feedback)) {
      warnings.push(`target "${t.name}": shares a feedback directory with an earlier target — counted once`);
      continue;
    }
    seenFeedback.add(t.feedback);
    suggestions.push(...discoverSuggestions(t.feedback, t.name));
  }

  if (config.scan?.enabled) {
    skills.push(...discoverProjectSkills({ roots: config.scan.roots, depth: config.scan.depth }));
  }

  // `surface` is a view preference, not a filter on what exists. Every suggestion
  // is still returned and still counted in `metrics`; each is only tagged with
  // whether the user asked to have it put in front of them. Applying it once here
  // means the app and the session line share one implementation without either
  // importing this package.
  const surface = surfaceOf(config);
  const today = localToday();
  // Handles are unique across every target, so this is the one place they can
  // be given out.
  assignUids(suggestions);
  for (const s of suggestions) {
    s.surfaced = passesSurface(s, surface);
    // Stamped per build, so it is true as of this state and every view that
    // groups by recency draws the same line in the same place.
    s.age = ageOf(s.date, today);
  }

  // A feedback folder whose skill no longer exists still holds real findings —
  // often the same live problem filed under a name that has since been renamed.
  const liveSkills = new Set(skills.map((s) => s.name));
  const orphans = [...new Set(suggestions.map((s) => s.skill))]
    .filter((name) => !liveSkills.has(name))
    .sort();

  // Terminal comes from the spec, so this list cannot drift from the model the
  // app and the TUI draw. Note `applied` is *not* terminal any more: a landed
  // change whose validation plan has not run is unfinished, and saying so is
  // the entire reason the verify phase exists.
  const open = suggestions.filter((s) => !isTerminal(s.status));

  // Two different waits wear the one `blocked_on` field, and they want opposite
  // things from the board. A block that names another suggestion still in play
  // is waiting on *that card* — no key of yours moves it, so it parks out of the
  // way. Every other block is waiting on *you*, and belongs in its own lane with
  // the flag up, where the key that moves it already is. Derived here for the
  // same reason uids are: it takes the whole corpus to answer. `blockedBy` goes
  // empty again once the card it names closes, which is what surfaces a member
  // whose carrier has landed.
  for (const s of suggestions) {
    s.blockedBy = s.blockedOn
      ? (open.find((o) => o.id !== s.id && (s.blockedOn.includes(o.id) || s.blockedOn.includes(o.slug)))
          ?.id ?? '')
      : '';
  }
  const byName = new Map();
  for (const s of suggestions) byName.set(s.skill, (byName.get(s.skill) ?? 0) + 1);

  return {
    generatedAt: new Date().toISOString(),
    targets,
    warnings,
    skills: skills.map((s) => {
      const suggestions = byName.get(s.name) ?? 0;
      // The ratio the whole thesis rests on: failures per unit of prose.
      const per100 = s.lines ? Number(((suggestions / s.lines) * 100).toFixed(2)) : 0;
      return { ...s, suggestions, per100, health: health(s, suggestions, per100) };
    }),
    suggestions,
    orphans,
    metrics: metrics(suggestions, skills, open),
  };
}

/**
 * The thesis, as a label.
 *
 * A skill with scripts and no complaints is the shape the system is trying to
 * produce; heavy prose with a high complaint rate is what it is trying to
 * remove. Computed here rather than in a front end because it is a fact about
 * the scan, and the scanner is the single source for everything else on the row.
 */
function health(skill, suggestions, per100) {
  if (skill.scripts > 0 && suggestions === 0) return 'scripted';
  if (per100 >= 2) return 'noisy';
  if (per100 > 0) return 'watch';
  return 'quiet';
}

function metrics(suggestions, skills, open) {
  const incidents = suggestions.reduce((sum, s) => sum + s.incidents, 0);
  const recurrences = suggestions.reduce((sum, s) => sum + s.recurrences, 0);
  const byRung = {};
  for (const s of suggestions) {
    if (s.rung === null) continue;
    byRung[s.rung] = (byRung[s.rung] ?? 0) + s.incidents;
  }
  const proseLines = skills.reduce((sum, s) => sum + s.lines, 0);
  return {
    total: suggestions.length,
    open: open.length,
    untriaged: suggestions.filter((s) => !s.triaged).length,
    // Parked on a decision only the user can make — the count that turns
    // "twelve identical triaged rows" into "three are yours".
    onYou: open.filter((s) => s.blockedOn).length,
    incidents,
    recurrences,
    incidentsByRung: byRung,
    proseLines,
    scriptCount: skills.reduce((sum, s) => sum + s.scripts, 0),
    incidentsPer100Lines: proseLines ? Number(((incidents / proseLines) * 100).toFixed(2)) : 0,
  };
}

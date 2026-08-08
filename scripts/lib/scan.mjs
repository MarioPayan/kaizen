/**
 * Reading the world: what skills exist, what they have filed, and how the two relate.
 *
 * Everything here reads in place. Skills are never copied into kaizen — a skill
 * edited in an editor is current the next time this runs, and there is no second
 * copy to drift.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSuggestion } from './suggestion.mjs';
import { clusterSuggestions } from './cluster.mjs';
import { resolveTargets, expandPath } from './config.mjs';
import { suggestionId } from './paths.mjs';

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
 * Bounded, opt-in discovery of project-level `.claude/skills`.
 * Depth-limited and cached by the caller: walking a repo root blindly is slow and
 * mostly rediscovers worktree duplicates.
 */
export function discoverProjectSkills({ roots = [], depth = 3 } = {}) {
  const out = [];
  const seen = new Set();

  const walk = (dir, level) => {
    if (level > depth) return;
    const candidate = join(dir, '.claude', 'skills');
    if (existsSync(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      out.push(
        ...discoverSkills(candidate, { target: `project:${dir}`, kind: 'project' }).map((s) => ({
          ...s,
          project: dir,
        })),
      );
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
  return out;
}

/** Read every suggestion filed under a feedback directory. */
export function discoverSuggestions(feedbackDir, targetName) {
  const out = [];
  if (!existsSync(feedbackDir)) return out;

  for (const entry of safeReaddir(feedbackDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
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
    if (!existsSync(t.feedback)) warnings.push(`target "${t.name}": feedback path not found — ${t.feedback}`);

    for (const skill of discoverSkills(t.skills, { target: t.name })) {
      if (seenSkillFiles.has(skill.path)) continue;
      seenSkillFiles.add(skill.path);
      skills.push(skill);
    }

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

  const clusters = clusterSuggestions(suggestions, { promotion: config.clusterPromotion });

  // A feedback folder whose skill no longer exists still holds real findings —
  // often the same live problem filed under a name that has since been renamed.
  const liveSkills = new Set(skills.map((s) => s.name));
  const orphans = [...new Set(suggestions.map((s) => s.skill))]
    .filter((name) => !liveSkills.has(name))
    .sort();

  const open = suggestions.filter((s) => !['applied', 'rejected', 'superseded'].includes(s.status));
  const byName = new Map();
  for (const s of suggestions) byName.set(s.skill, (byName.get(s.skill) ?? 0) + 1);

  return {
    generatedAt: new Date().toISOString(),
    targets,
    warnings,
    skills: skills.map((s) => ({
      ...s,
      suggestions: byName.get(s.name) ?? 0,
      // The ratio the whole thesis rests on: failures per unit of prose.
      per100: s.lines ? Number((((byName.get(s.name) ?? 0) / s.lines) * 100).toFixed(2)) : 0,
    })),
    suggestions,
    clusters,
    orphans,
    metrics: metrics(suggestions, skills, clusters, open),
  };
}

function metrics(suggestions, skills, clusters, open) {
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
    incidents,
    recurrences,
    clusters: clusters.length,
    promotedClusters: clusters.filter((c) => c.promoted).length,
    incidentsByRung: byRung,
    proseLines,
    scriptCount: skills.reduce((sum, s) => sum + s.scripts, 0),
    incidentsPer100Lines: proseLines ? Number(((incidents / proseLines) * 100).toFixed(2)) : 0,
  };
}

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { expandPath, resolveTargets } from './config.mjs';
import { parseSuggestion } from './suggestion.mjs';
import { isInside, suggestionId } from './paths.mjs';

function entries(path, options) {
  try {
    return readdirSync(path, options);
  } catch {
    return [];
  }
}

/** Discover direct skills, skills-dir plugins, and shared Markdown under lib/. */
export function discoverSkills(skillsDir, { target = '', kind = 'user' } = {}) {
  if (!existsSync(skillsDir)) return [];
  const found = [];
  const addLibrary = (root, path) => {
    for (const entry of entries(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) addLibrary(root, full);
      else if (entry.name.endsWith('.md'))
        found.push({ name: relative(root, full), target, kind: 'library', path: full });
    }
  };
  for (const entry of entries(skillsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const directory = join(skillsDir, entry.name);
    if (entry.name === '_lib' || entry.name === 'lib') {
      addLibrary(skillsDir, directory);
      continue;
    }
    const plugin = join(directory, 'skills');
    const candidates =
      existsSync(join(directory, '.claude-plugin', 'plugin.json')) && existsSync(plugin)
        ? entries(plugin, { withFileTypes: true })
            .filter((item) => item.isDirectory() || item.isSymbolicLink())
            .map((item) => [item.name, join(plugin, item.name)])
        : [[entry.name, directory]];
    for (const [name, candidate] of candidates) {
      const path = join(candidate, 'SKILL.md');
      if (existsSync(path)) found.push({ name, target, kind, path, dir: candidate });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export function discoverProjectSkills({ roots = [], depth = 3 } = {}) {
  const found = [];
  const seen = new Set();
  const walk = (directory, level) => {
    if (level > depth) return;
    const skills = join(directory, '.claude', 'skills');
    if (existsSync(skills)) {
      for (const skill of discoverSkills(skills, { target: `project:${directory}`, kind: 'project' })) {
        const key = `${directory}\0${skill.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          found.push({ ...skill, project: directory });
        }
      }
    }
    for (const entry of entries(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
        walk(join(directory, entry.name), level + 1);
    }
  };
  for (const root of roots) if (existsSync(expandPath(root))) walk(expandPath(root), 1);
  return found;
}

export function normalizeScope(scope, skillsDir = '') {
  if (!scope) return scope;
  if (!isAbsolute(scope) && scope !== '~' && !scope.startsWith(`~${sep}`)) return normalize(scope);
  const absolute = expandPath(scope);
  const root = skillsDir && expandPath(skillsDir);
  return root && isInside(root, absolute) ? relative(root, absolute) || '.' : absolute;
}

export function discoverSuggestions(feedbackDir, targetName, skillsDir = '') {
  if (!existsSync(feedbackDir)) return [];
  const found = [];
  for (const entry of entries(feedbackDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    for (const name of entries(join(feedbackDir, entry.name))) {
      if (!name.endsWith('.md')) continue;
      const file = join(feedbackDir, entry.name, name);
      try {
        const item = parseSuggestion({
          id: suggestionId(targetName, entry.name, name),
          file,
          skill: entry.name,
          target: targetName,
          text: readFileSync(file, 'utf8'),
        });
        item.scope = normalizeScope(item.scope, skillsDir);
        item.patch = existsSync(file.replace(/\.md$/, '.patch')) ? file.replace(/\.md$/, '.patch') : null;
        found.push(item);
      } catch {
        // One unreadable capture must not hide the rest of the backlog.
      }
    }
  }
  return found;
}

export function scopePath(item, target) {
  if (!item.scope) return '';
  return isAbsolute(item.scope) ? item.scope : resolve(target.skills, item.scope);
}

export function buildState(config) {
  const targets = resolveTargets(config);
  const skills = [];
  const suggestions = [];
  const warnings = [];
  const seenFeedback = new Set();
  const seenSkills = new Set();
  const feedbackSkills = new Set();
  for (const target of targets) {
    if (!existsSync(target.skills))
      warnings.push(`target "${target.name}": skills path not found — ${target.skills}`);
    if (target.feedback && !existsSync(target.feedback))
      warnings.push(`target "${target.name}": feedback path not found — ${target.feedback}`);
    for (const skill of discoverSkills(target.skills, { target: target.name })) {
      if (!seenSkills.has(skill.path)) {
        seenSkills.add(skill.path);
        skills.push(skill);
      }
    }
    if (target.feedback && !seenFeedback.has(target.feedback)) {
      seenFeedback.add(target.feedback);
      for (const entry of entries(target.feedback, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
          feedbackSkills.add(entry.name);
      }
      suggestions.push(...discoverSuggestions(target.feedback, target.name, target.skills));
    }
  }
  if (config.scan?.enabled)
    skills.push(...discoverProjectSkills({ roots: config.scan.roots, depth: config.scan.depth }));
  const liveSkills = new Set(skills.filter((skill) => skill.kind !== 'library').map((skill) => skill.name));
  return {
    generatedAt: new Date().toISOString(),
    targets,
    warnings,
    skills,
    suggestions,
    orphans: [...feedbackSkills].filter((name) => name !== 'session' && !liveSkills.has(name)).sort(),
    metrics: {
      total: suggestions.length,
      open: suggestions.filter((item) => item.status === 'open').length,
    },
  };
}

export function targetFor(config, name) {
  return resolveTargets(config).find((target) => target.name === name);
}

export function relativeToTarget(item, target) {
  const path = scopePath(item, target);
  return path && isInside(dirname(target.skills), path) ? relative(dirname(target.skills), path) : path;
}

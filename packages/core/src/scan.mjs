import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

const repoRoots = new Map();

/** The git toplevel that owns a skills dir; scopes are relative to it, not to the skills dir. */
export function repoRoot(dir) {
  if (!repoRoots.has(dir)) {
    let root = dir;
    try {
      root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Not a repository: fall back to the skills dir itself.
    }
    repoRoots.set(dir, root);
  }
  return repoRoots.get(dir);
}

/** A scope without its trailing note ("… §1.3", "… (why)"). */
export function bareScope(scope) {
  return String(scope ?? '').replace(/\s+(§.*|\(.*\))$/, '');
}

/**
 * Rewrite a scope through a target's `scopeAliases` (old path -> new path). A key ending in `/`
 * maps a whole directory prefix; any other key maps one exact path. The longest key wins.
 */
export function applyScopeAlias(scope, aliases) {
  if (!scope || !aliases) return scope;
  const keys = Object.keys(aliases).sort((a, b) => b.length - a.length);
  for (const from of keys) {
    if (scope === from) return aliases[from];
    if (from.endsWith('/') && scope.startsWith(from)) return aliases[from] + scope.slice(from.length);
  }
  return scope;
}

export function scopePath(item, target) {
  if (!item.scope) return '';
  const bare = applyScopeAlias(bareScope(item.scope), target.scopeAliases);
  // expandPath also resolves relative paths against cwd, so only use it for ~ forms.
  const scope = bare.startsWith('~') ? expandPath(bare) : bare;
  if (isAbsolute(scope)) return scope;
  const root = repoRoot(target.skills);
  // Captures also write paths relative to the skills dir or to the repo's parent.
  const tries = [resolve(root, scope), resolve(target.skills, scope), resolve(dirname(root), scope)];
  return tries.find((path) => existsSync(path)) ?? tries[0];
}

/**
 * One group key per file, however a capture spelled it: relative to the target repo holding it
 * (prefixed `<target>:` for every target but the first), else ~-absolute.
 */
export function scopeKey(item, targets) {
  const own = targets.find((target) => target.name === item.target);
  const path = own ? scopePath(item, own) : item.scope;
  if (!path) return '';
  for (const [i, target] of targets.entries()) {
    const root = repoRoot(target.skills);
    if (!isInside(root, path)) continue;
    const rel = relative(root, path) || '.';
    return i === 0 ? rel : `${target.name}:${rel}`;
  }
  return path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
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

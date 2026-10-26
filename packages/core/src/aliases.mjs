/**
 * Propose `scopeAliases` for scopes that point at files which no longer exist.
 *
 * Read-only. For each target, every distinct scope (any status) that does not resolve to an
 * existing file is looked up in two places, first hit wins:
 *   1. the rename history of the git repository owning the target's skills dir
 *      (`git log --name-status -M --diff-filter=R`), followed to the newest name, which must exist;
 *   2. for a `_lib/` path, the one tracked file with the same basename under `lib/` or `rules/`.
 * Everything else is reported as unresolved for a human to map or re-scope.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { bareScope, repoRoot, scopePath } from './scan.mjs';
import { isInside } from './paths.mjs';

function gitLines(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** old path -> newer path, from the newest rename of each old path. */
export function renameMap(root) {
  const renames = new Map();
  for (const line of gitLines(root, ['log', '--name-status', '-M', '--diff-filter=R', '--format='])) {
    const [status, from, to] = line.split('\t');
    if (status?.startsWith('R') && from && to && !renames.has(from)) renames.set(from, to);
  }
  return renames;
}

function follow(renames, path) {
  const seen = new Set();
  while (renames.has(path) && !seen.has(path)) {
    seen.add(path);
    path = renames.get(path);
  }
  return path;
}

export function proposeAliases(state) {
  return state.targets.map((target) => {
    const root = repoRoot(target.skills);
    const renames = renameMap(root);
    const tracked = gitLines(root, ['ls-files']).filter((path) => /^(lib|rules)\//.test(path));
    const aliases = {};
    const unresolved = new Set();
    const scopes = new Set(
      state.suggestions.filter((item) => item.target === target.name && item.scope).map((item) => item.scope),
    );
    for (const scope of scopes) {
      if (existsSync(scopePath({ scope }, target))) continue;
      const bare = bareScope(scope);
      if (bare in aliases) continue;
      // Prose scopes ("Notion page …") are not paths; a human re-scopes them.
      if (/\s/.test(bare)) {
        unresolved.add(bare);
        continue;
      }
      const absolute = bare.startsWith('~') || isAbsolute(bare);
      const keys = absolute
        ? [scopePath({ scope: bare }, target)]
            .filter((path) => isInside(root, path))
            .map((p) => relative(root, p))
        : [bare, resolve(target.skills, bare), resolve(dirname(root), bare)]
            .map((path) => (isAbsolute(path) ? relative(root, path) : path))
            .filter((path) => path && !path.startsWith('..'));
      let found = keys
        .map((key) => follow(renames, key))
        .find((path, index) => path !== keys[index] && existsSync(resolve(root, path)));
      if (!found && /(^|\/)_lib\//.test(bare)) {
        const same = tracked.filter((path) => basename(path) === basename(bare));
        if (same.length === 1) found = same[0];
      }
      if (found) aliases[bare] = found;
      else unresolved.add(bare);
    }
    return {
      target: target.name,
      aliases: Object.fromEntries(Object.entries(aliases).sort()),
      unresolved: [...unresolved].sort(),
    };
  });
}

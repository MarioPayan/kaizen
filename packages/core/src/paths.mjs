/**
 * Path containment.
 *
 * The API accepts identifiers that map to files on disk. Without this check a
 * crafted id could read or write anywhere the process can reach, so containment
 * is asserted at the boundary rather than assumed from well-formed callers.
 */
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';

/** True when `child` is inside `parent` (or is `parent`). */
export function isInside(parent, child) {
  const p = resolve(parent);
  const c = resolve(child);
  if (p === c) return true;
  const rel = relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve `candidate` and confirm it sits inside one of `roots`.
 * Symlinks are resolved first — a link pointing out of the tree escapes a check
 * that only compares the literal path.
 */
export function assertInside(roots, candidate, label = 'path') {
  const list = Array.isArray(roots) ? roots : [roots];
  let target = resolve(candidate);

  if (target.includes('\0')) throw new Error(`${label}: null byte in path`);

  if (existsSync(target)) {
    try {
      target = realpathSync(target);
    } catch {
      /* unreadable — fall through and check the literal path */
    }
  }

  const allowed = list.map((r) => {
    const abs = resolve(r);
    try {
      return existsSync(abs) ? realpathSync(abs) : abs;
    } catch {
      return abs;
    }
  });

  if (!allowed.some((root) => isInside(root, target))) {
    throw new Error(`${label}: refused — "${candidate}" resolves outside every configured target`);
  }
  return target;
}

/** Suggestion ids are `<target>/<skill>/<filename>` and nothing more exotic. */
const ID_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function parseSuggestionId(id) {
  if (typeof id !== 'string') throw new Error('suggestion id must be a string');
  const parts = id.split('/');
  if (parts.length !== 3) throw new Error(`malformed suggestion id: "${id}"`);
  for (const part of parts) {
    if (!ID_SEGMENT.test(part) || part === '.' || part === '..') {
      throw new Error(`malformed suggestion id segment: "${part}"`);
    }
  }
  const [target, skill, file] = parts;
  if (!file.endsWith('.md')) throw new Error(`suggestion id must point at a .md file: "${id}"`);
  return { target, skill, file };
}

export function suggestionId(target, skill, file) {
  return [target, skill, file].join('/');
}

export { sep };

/**
 * Memory lint: Claude Code project memories (`<projects>/<project>/memory/*.md`) that name a file
 * which no longer exists.
 *
 * A reference is a path-shaped token ending in a file extension, with or without `~/` or `/`.
 * URLs and template placeholders (`<name>`, `{x}`, `*`, `$VAR`) are skipped. An absolute or `~/`
 * reference is missing when the file does not exist. A relative reference is resolved against its
 * owner, the first base that knows it. Bases, in order: the project dir, the project's working
 * directory (read from one of its transcripts) and its repository root, the target repository
 * holding that directory, and each target's feedback dir. A base knows a reference when the
 * reference's directory exists there; the target repository also knows every first path segment
 * it ever tracked in git, so a removed `_lib/` still counts. The reference is missing when the
 * file is absent under its owner; one no base knows is skipped, since its context is unknown.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { expandPath } from './config.mjs';
import { isInside } from './paths.mjs';
import { repoRoot } from './scan.mjs';

const REFERENCE = /(?:~\/|\/)?[\w.@-]+(?:\/[\w.@-]+)+\.(?:md|sh|py|mjs|cjs|js|ts|json|jsonl|ya?ml|toml)\b/g;
const PLACEHOLDER = /[<>{}*$]/;

function list(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The cwd recorded in the first transcript lines of a project dir, or ''. */
export function projectCwd(projectDir) {
  for (const entry of list(projectDir)) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    let text;
    try {
      const fd = openSync(join(projectDir, entry.name), 'r');
      const buffer = Buffer.alloc(65536);
      text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
      closeSync(fd);
    } catch {
      continue;
    }
    const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
    if (cwd) return JSON.parse(`"${cwd}"`);
  }
  return '';
}

export function references(text) {
  const found = new Set();
  const plain = text.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, ' ');
  for (const match of plain.matchAll(REFERENCE)) {
    const before = plain[match.index - 1] ?? '';
    const after = plain[match.index + match[0].length] ?? '';
    if (PLACEHOLDER.test(before) || PLACEHOLDER.test(after) || /[\w.-]/.test(before)) continue;
    found.add(match[0]);
  }
  return [...found];
}

const historySegments = new Map();

/** First path segments ever tracked in a git repository (cached). */
function tracked(root) {
  if (!historySegments.has(root)) {
    let names = '';
    try {
      names = execFileSync('git', ['-C', root, 'log', '--all', '--format=', '--name-only'], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // Not a repository: only the current tree counts.
    }
    historySegments.set(root, new Set(names.split('\n').map((name) => name.split('/')[0])));
  }
  return historySegments.get(root);
}

export function lintMemory({ projectsDir, targets = [] }) {
  const findings = [];
  const repos = new Set(targets.map((target) => repoRoot(target.skills)));
  const feedback = targets.map((target) => target.feedback).filter(Boolean);
  for (const project of list(projectsDir)) {
    if (!project.isDirectory()) continue;
    const projectDir = join(projectsDir, project.name);
    const memoryDir = join(projectDir, 'memory');
    const files = list(memoryDir).filter((entry) => entry.isFile() && entry.name.endsWith('.md'));
    if (!files.length) continue;
    const cwd = projectCwd(projectDir);
    const own = cwd ? [...repos].filter((repo) => isInside(repo, cwd)) : [];
    const bases = [projectDir, ...(cwd ? [cwd, repoRoot(cwd)] : []), ...own, ...feedback];
    const knows = (base, reference) =>
      existsSync(dirname(resolve(base, reference))) ||
      (own.includes(base) && tracked(base).has(reference.split('/')[0]));
    for (const file of files) {
      const path = join(memoryDir, file.name);
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      for (const reference of references(text)) {
        let exists;
        if (reference.startsWith('~/') || isAbsolute(reference)) exists = existsSync(expandPath(reference));
        else {
          const owner = bases.find((base) => knows(base, reference));
          if (!owner) continue;
          exists = existsSync(resolve(owner, reference));
        }
        if (!exists) findings.push({ file: path, reference });
      }
    }
  }
  return findings;
}

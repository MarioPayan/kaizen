#!/usr/bin/env node
/**
 * Fails while shipped plugin files changed since the last plugin version bump.
 *
 * `claude plugin update` refreshes an installed plugin only when `.claude-plugin/plugin.json`
 * carries a new version, so a behaviour change without a bump never reaches installed copies.
 * The base is the last commit whose diff touched the manifest's "version" line; an uncommitted
 * version change in the working tree counts as the bump. Usage: version-check.mjs [repo-root].
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const SHIPPED = ['scripts', 'skills', 'hooks', 'commands', 'packages/core/src'];
const MANIFEST = '.claude-plugin/plugin.json';
const root = resolve(argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));

const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
const version = (text) => {
  try {
    return JSON.parse(text).version ?? '';
  } catch {
    return '';
  }
};

let base;
let committed;
try {
  // The last commit that added or removed the manifest's `"version": ...` key line (a POSIX
  // regex, passed without a shell); "version" elsewhere, as in a description, is not a bump.
  base = git('log', '-1', '--format=%H', '-G^[[:space:]]*"version"[[:space:]]*:', '--', MANIFEST);
  committed = version(git('show', `HEAD:${MANIFEST}`));
} catch {
  base = '';
}
if (!base) {
  console.log(`version-check: could not evaluate (no git history for ${MANIFEST})`);
  exit(0);
}
const current = version(readFileSync(join(root, MANIFEST), 'utf8'));
if (current && current !== committed) {
  console.log(`version-check: ok (version bumped to ${current}, not yet committed)`);
  exit(0);
}
const changed = git('diff', '--name-only', base, '--', ...SHIPPED)
  .split('\n')
  .filter(Boolean);
const untracked = git('ls-files', '--others', '--exclude-standard', '--', ...SHIPPED)
  .split('\n')
  .filter(Boolean);
const files = [...new Set([...changed, ...untracked])].sort();
if (!files.length) {
  console.log(`version-check: ok (no shipped file changed since version ${current})`);
  exit(0);
}
console.error(
  `version-check: FAIL ${files.length} shipped file(s) changed since version ${current} (${base.slice(0, 7)}) ` +
    `without a version bump; bump "version" in ${MANIFEST} so \`claude plugin update\` picks them up:\n  ${files.join('\n  ')}`,
);
exit(1);

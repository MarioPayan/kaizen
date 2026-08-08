/**
 * Worktrees hold the same files as their main repo, so a scan that lists them
 * separately reports a repo with 24 worktrees as 24 copies of every skill. This
 * covers the collapsing, because the failure is silent — nothing errors, the
 * inventory is just mostly duplicates.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProjectSkills } from '../lib/scan.mjs';

let root;
const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });

const addSkill = (dir, name) => {
  mkdirSync(join(dir, '.claude', 'skills', name), { recursive: true });
  writeFileSync(join(dir, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n\n# ${name}\n`);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kaizen-wt-'));
  const main = join(root, 'main-repo');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  addSkill(main, 'alpha');
  addSkill(main, 'beta');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');

  // Two worktrees of the same repo — each carries alpha and beta on disk.
  git(main, 'worktree', 'add', '-q', '-b', 'wt1', join(root, 'wt-one'));
  git(main, 'worktree', 'add', '-q', '-b', 'wt2', join(root, 'wt-two'));

  // An unrelated repo that happens to use the same skill name.
  const other = join(root, 'other-repo');
  mkdirSync(other, { recursive: true });
  git(other, 'init', '-q', '-b', 'main');
  addSkill(other, 'alpha');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'init');

  // A plain directory, not a repo at all.
  const plain = join(root, 'plain-dir');
  mkdirSync(plain, { recursive: true });
  addSkill(plain, 'gamma');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('project skill discovery', () => {
  it('lists each skill once per repository, not once per worktree', () => {
    const found = discoverProjectSkills({ roots: [root], depth: 2 });
    const fromMain = found.filter((s) => s.project.endsWith('main-repo'));
    expect(fromMain.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
    expect(fromMain[0].worktrees).toBe(2);
  });

  it('keeps a same-named skill from a genuinely different repo', () => {
    const found = discoverProjectSkills({ roots: [root], depth: 2 });
    const alphas = found.filter((s) => s.name === 'alpha');
    expect(alphas).toHaveLength(2);
    expect(new Set(alphas.map((s) => s.project)).size).toBe(2);
  });

  it('still finds skills in a directory that is not a git repo', () => {
    const found = discoverProjectSkills({ roots: [root], depth: 2 });
    const gamma = found.find((s) => s.name === 'gamma');
    expect(gamma).toBeDefined();
    expect(gamma.worktrees).toBe(0);
  });

  it('respects the depth bound', () => {
    expect(discoverProjectSkills({ roots: [root], depth: 0 })).toEqual([]);
  });

  it('ignores a root that does not exist', () => {
    expect(discoverProjectSkills({ roots: [join(root, 'nope')], depth: 2 })).toEqual([]);
  });
});

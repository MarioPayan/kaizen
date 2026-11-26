import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, write } from './helpers.mjs';

const script = resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'version-check.mjs',
);
const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

const manifest = (version) => JSON.stringify({ name: 'kaizen', version }, null, 2) + '\n';
const check = (root) => {
  const result = spawnSync('node', [script, root], { encoding: 'utf8' });
  return { status: result.status, out: result.stdout + result.stderr };
};

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'kaizen-version-'));
  roots.push(root);
  git(root, 'init', '-q');
  write(join(root, '.claude-plugin', 'plugin.json'), manifest('0.1.0'));
  write(join(root, 'scripts', 'cli.mjs'), 'one\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

describe('version-check', () => {
  it('passes until a shipped file changes, then fails until the version is bumped', () => {
    const root = repo();
    expect(check(root)).toMatchObject({ status: 0 });
    write(join(root, 'docs', 'notes.md'), 'docs are not shipped behaviour\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'docs');
    expect(check(root).status).toBe(0);

    write(join(root, 'scripts', 'cli.mjs'), 'two\n');
    git(root, 'commit', '-qam', 'behaviour');
    write(join(root, 'skills', 'kaizen', 'SKILL.md'), 'new, untracked\n');
    // A manifest line that only mentions "version" as a value is not a bump.
    write(
      join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'kaizen', note: 'version', version: '0.1.0' }, null, 2) + '\n',
    );
    git(root, 'commit', '-qam', 'note');
    const failed = check(root);
    expect(failed.status).toBe(1);
    expect(failed.out).toContain('FAIL 2 shipped file(s) changed since version 0.1.0');
    expect(failed.out).toContain('scripts/cli.mjs');
    expect(failed.out).toContain('skills/kaizen/SKILL.md');

    write(join(root, '.claude-plugin', 'plugin.json'), manifest('0.2.0'));
    expect(check(root)).toMatchObject({ status: 0 });
    expect(check(root).out).toContain('bumped to 0.2.0, not yet committed');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'bump');
    expect(check(root)).toMatchObject({ status: 0 });
    expect(check(root).out).toContain('no shipped file changed since version 0.2.0');
  });

  it('reports could not evaluate outside a git repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'kaizen-version-'));
    roots.push(root);
    write(join(root, '.claude-plugin', 'plugin.json'), manifest('0.1.0'));
    expect(check(root)).toMatchObject({ status: 0 });
    expect(check(root).out).toContain('could not evaluate');
  });
});

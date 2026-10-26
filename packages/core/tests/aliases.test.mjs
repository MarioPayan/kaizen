import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyScopeAlias } from '../src/scan.mjs';
import { cleanup, card, git, run, workspace, write } from './helpers.mjs';

afterEach(cleanup);

describe('scope aliases', () => {
  it('maps exact paths and directory prefixes, longest key first', () => {
    const aliases = { '_lib/': 'lib/', '_lib/claude-md-guardrails.md': 'rules/guardrails.md' };
    expect(applyScopeAlias('_lib/claude-md-guardrails.md', aliases)).toBe('rules/guardrails.md');
    expect(applyScopeAlias('_lib/pr/x.sh', aliases)).toBe('lib/pr/x.sh');
    expect(applyScopeAlias('_lib', aliases)).toBe('_lib');
    expect(applyScopeAlias('other.md', undefined)).toBe('other.md');
  });

  it('proposes aliases from git renames and _lib basenames, and the config fixes grouping and doctor', () => {
    const { repo, feedback, config } = workspace();
    write(join(repo, '_lib', 'claude-md-guardrails.md'), 'rules\n');
    write(join(repo, 'lib', 'obsidian', 'find-vault.sh'), 'echo\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    mkdirSync(join(repo, 'rules'));
    git(repo, 'mv', '_lib/claude-md-guardrails.md', 'rules/guardrails.md');
    git(repo, 'commit', '-qm', 'move');
    card(feedback, 'session', '2026-09-01-one', { frontmatter: { scope: '_lib/claude-md-guardrails.md' } });
    card(feedback, 'session', '2026-09-02-two', { frontmatter: { scope: 'rules/guardrails.md §2' } });
    card(feedback, 'session', '2026-09-03-three', { frontmatter: { scope: '_lib/obsidian-find-vault.sh' } });
    card(feedback, 'session', '2026-09-04-four', { frontmatter: { scope: '_lib/find-vault.sh' } });
    card(feedback, 'session', '2026-09-05-five', { frontmatter: { scope: 'lib/never/created.md' } });

    const proposed = JSON.parse(run(config, 'aliases').stdout).proposals;
    expect(proposed).toEqual([
      {
        target: 'user',
        aliases: {
          '_lib/claude-md-guardrails.md': 'rules/guardrails.md',
          '_lib/find-vault.sh': 'lib/obsidian/find-vault.sh',
        },
        unresolved: ['_lib/obsidian-find-vault.sh', 'lib/never/created.md'],
      },
    ]);
    expect(run(config, 'doctor').stdout).toContain('scope does not exist');

    const json = JSON.parse(readFileSync(config, 'utf8'));
    json.targets[0].scopeAliases = proposed[0].aliases;
    writeFileSync(config, JSON.stringify(json));
    const doctor = run(config, 'doctor').stdout;
    expect(doctor).not.toContain('2026-09-01-one');
    expect(doctor).toContain('lib/never/created.md');
    const groups = JSON.parse(run(config, 'list').stdout).groups;
    expect(groups.find((group) => group.key === 'rules/guardrails.md').items).toHaveLength(2);
    expect(JSON.parse(run(config, 'aliases').stdout).proposals[0].aliases).toEqual({});
  });

  it('rejects a malformed scopeAliases entry', () => {
    const { config } = workspace({ target: { scopeAliases: { 'a.md': '' } } });
    expect(run(config, 'doctor').stderr).toContain('targets[0].scopeAliases must map old scope paths');
  });
});

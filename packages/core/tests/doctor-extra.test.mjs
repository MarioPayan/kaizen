import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { originBullets, references } from '../src/index.mjs';
import { cleanup, card, editConfig, git, run, workspace, write } from './helpers.mjs';

afterEach(cleanup);

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

describe('doctor: memory lint', () => {
  it('extracts path references and skips URLs and placeholders', () => {
    expect(
      references(
        'see `_lib/skill-reflect.md`, ~/.claude/x/y.sh and /abs/z.py; https://e.com/a/b.md ' +
          '<feedback>/<skill>/x.md and ${HOME}/q/r.md',
      ),
    ).toEqual(['_lib/skill-reflect.md', '~/.claude/x/y.sh', '/abs/z.py']);
  });

  it('flags a memory naming a file that moved out of its own repository, and nothing else', () => {
    const { root, repo, config } = workspace();
    write(join(repo, '_lib', 'skill-reflect.md'), 'x\n');
    write(join(repo, 'lib', 'meta', 'skill-reflect.md'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'rm', '-q', '_lib/skill-reflect.md');
    git(repo, 'commit', '-qm', 'move');
    const project = join(root, 'projects', '-repo');
    write(join(project, 'session.jsonl'), `${JSON.stringify({ type: 'user', cwd: repo })}\n`);
    write(
      join(project, 'memory', 'convention.md'),
      [
        'Every skill applies `_lib/skill-reflect.md` (now lib/meta/skill-reflect.md).',
        `Absolute: ${join(repo, 'gone.sh')} and ${join(repo, 'lib', 'meta', 'skill-reflect.md')}.`,
        'Unknown context: src/app/never-seen.ts.',
      ].join('\n'),
    );
    const lines = run(config, 'doctor')
      .stdout.split('\n')
      .filter((line) => line.includes('memory-path-missing'));
    expect(lines).toEqual([
      `[low] memory-path-missing: ${join(project, 'memory', 'convention.md')} references _lib/skill-reflect.md, which does not exist`,
      `[low] memory-path-missing: ${join(project, 'memory', 'convention.md')} references ${join(repo, 'gone.sh')}, which does not exist`,
    ]);
  });
});

describe('doctor: rule retirement candidates', () => {
  it('parses origin comments on bullets only', () => {
    expect(
      originBullets(
        [
          '- keep A <!-- origin: session/2026-08-01-trap-a.md -->',
          '1. keep B <!-- origin: 2026-08-02-trap-b, trap-c -->',
          'prose <!-- origin: not-a-bullet -->',
        ].join('\n'),
      ),
    ).toEqual([
      { line: 1, text: '- keep A <!-- origin: session/2026-08-01-trap-a.md -->', origins: ['trap-a'] },
      {
        line: 2,
        text: '1. keep B <!-- origin: 2026-08-02-trap-b, trap-c -->',
        origins: ['trap-b', 'trap-c'],
      },
    ]);
  });

  it('lists bullets whose origin has no suggestion in 60 days, matching by slug or by scope and words', () => {
    const { skills, feedback, config } = workspace();
    const rules = write(
      join(skills, 'rules', 'guardrails.md'),
      [
        '# Guardrails',
        '- quiet rule <!-- origin: old-quiet-trap -->',
        '- recent by slug <!-- origin: recent-trap -->',
        '- recent by scope <!-- origin: zsh-word-splitting-loop -->',
        '- recurring <!-- origin: old-but-recurring -->',
        '- no origin',
      ].join('\n'),
    );
    editConfig(config, (json) => (json.budgets = [{ path: join(skills, 'rules'), maxBytes: 100000 }]));
    card(feedback, 'session', `${daysAgo(200)}-old-quiet-trap`);
    card(feedback, 'session', `${daysAgo(5)}-recent-trap`, { frontmatter: { status: 'fixed' } });
    card(feedback, 'session', `${daysAgo(3)}-zsh-splitting-again`, {
      frontmatter: { scope: 'rules/guardrails.md' },
    });
    card(feedback, 'session', `${daysAgo(300)}-old-but-recurring`, {
      body: `## Context\n\nc\n\n## Recurrence — ${daysAgo(10)}\n\nagain`,
    });
    const lines = run(config, 'doctor')
      .stdout.split('\n')
      .filter((line) => line.includes('retirement-candidate'));
    expect(lines).toEqual([
      `[low] retirement-candidate: ${rules}:2 origin old-quiet-trap has no matching suggestion in 60 days (human decides): - quiet rule <!-- origin: old-quiet-trap -->`,
    ]);
  });
});

describe('doctor: budgets', () => {
  it('measures a single file, through a symlink', () => {
    const { root, config } = workspace();
    const real = write(join(root, 'skills-config', 'CLAUDE.md'), 'x'.repeat(50));
    const link = join(root, 'CLAUDE.md');
    symlinkSync(real, link);
    editConfig(config, (json) => (json.budgets = [{ path: link, maxBytes: 40 }]));
    expect(run(config, 'doctor').stdout).toContain(`budget-exceeded: ${link} is 50 bytes; budget is 40`);
  });
});

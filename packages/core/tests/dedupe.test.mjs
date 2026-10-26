import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, card, run, workspace, write } from './helpers.mjs';
import { join } from 'node:path';

afterEach(cleanup);

const check = (config, skill, scope, slug) =>
  JSON.parse(run(config, 'capture', '--check', '--skill', skill, '--scope', scope, '--slug', slug).stdout);

describe('capture --check across skills', () => {
  it('finds an open lookalike filed under another skill', () => {
    const { feedback, config } = workspace();
    const open = card(feedback, 'babysit-pr', '2026-09-16-background-wait-ends-subagent-run', {
      frontmatter: { scope: 'babysit-pr/SKILL.md' },
    });
    const result = check(config, 'pr-create', 'lib/github/post-push.md', 'babysit-background-ends-subagent');
    expect(result.match).toBe(open);
    expect(result.reason).toBe('babysit-pr shares 3/4 words: background, ends, subagent');
  });

  it('matches the same scope file in another skill when three words overlap, using the title too', () => {
    const { skills, feedback, config } = workspace();
    write(join(skills, 'lib', 'shell.md'), '# shell\n');
    const open = card(feedback, 'session', '2026-09-01-zsh-trap', {
      frontmatter: { scope: 'skills/lib/shell.md' },
      body: '# zsh word splitting breaks loops\n\n## Context\n\nc\n\n## Suggestion\n\ns',
    });
    card(feedback, 'session', '2026-09-02-shell-unrelated', {
      frontmatter: { scope: 'skills/lib/shell.md' },
    });
    const result = check(
      config,
      'babysit-pr',
      join(skills, 'lib', 'shell.md'),
      'loops-zsh-splitting-pnpm-vite-turbo-cache',
    );
    expect(result.match).toBe(open);
    expect(result.reason).toMatch(/^same scope file in session and 3 shared words: loops, splitting, zsh$/);
    expect(check(config, 'babysit-pr', join(skills, 'lib', 'shell.md'), 'pnpm-shell-cache').match).toBeNull();
  });

  it('reports a fixed lookalike as fixedMatch and ignores dropped ones', () => {
    const { feedback, config } = workspace();
    const fixed = card(feedback, 'session', '2026-08-30-gh-pr-edit-blocked-by-projects', {
      frontmatter: { status: 'fixed', scope: 'lib/pr/edit-pr.sh' },
    });
    card(feedback, 'session', '2026-08-30-notion-cursor-missing-pages', {
      frontmatter: { status: 'dropped', scope: 'lib/notion.md' },
    });
    const result = check(config, 'pr-create', 'x.md', 'gh-pr-edit-projects-classic-blocked');
    expect(result).toMatchObject({ match: null, fixedMatch: fixed });
    expect(check(config, 'pr-create', 'x.md', 'notion-cursor-missing-pages')).not.toHaveProperty(
      'fixedMatch',
    );
  });
});

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, card, git, run, workspace } from './helpers.mjs';

afterEach(cleanup);

const body = (...headings) =>
  ['## Context\n\nc\n\n## Suggestion\n\ns', ...headings.map((heading) => `## ${heading}\n\nagain`)].join(
    '\n\n',
  );

describe('recurred after fix', () => {
  it('flags a fixed item whose recurrence is dated after verified_at, and lists it again', () => {
    const { feedback, config } = workspace();
    card(feedback, 'session', '2026-08-30-gh-pr-edit-blocked', {
      frontmatter: { status: 'fixed', verified_at: '2026-09-04 — self-check ok' },
      body: body('Recurrence — 2026-09-06', 'Recurrence - 2026-09-11, other repo', 'Recurrence'),
    });
    card(feedback, 'session', '2026-08-01-old-recurrence', {
      frontmatter: { status: 'fixed', closed_at: '2026-09-10T00:00:00.000Z' },
      body: body('Recurrence — 2026-09-05', 'Recurrence — 2026-09-10'),
    });
    const doctor = run(config, 'doctor');
    expect(doctor.stdout).toContain(
      'recurred-after-fix: user/session/2026-08-30-gh-pr-edit-blocked.md was fixed on 2026-09-04 (verified_at) and recurred 2× after: 2026-09-06, 2026-09-11',
    );
    expect(doctor.stdout).not.toContain('old-recurrence');

    const list = JSON.parse(run(config, 'list').stdout);
    const items = list.groups.flatMap((group) => group.items);
    expect(items.map((item) => item.id)).toEqual(['user/session/2026-08-30-gh-pr-edit-blocked.md']);
    expect(items[0].status).toBe('fixed');
    expect(items[0].recurredAfterFix).toEqual({
      fixedOn: '2026-09-04',
      source: 'verified_at',
      dates: ['2026-09-06', '2026-09-11'],
    });
    expect(run(config, 'list', '--text').stdout).toContain('recurred after fix 2026-09-04');
  });

  it('lets close fix a recurred item again, which takes it out of the backlog', () => {
    const { feedback, config } = workspace();
    const file = card(feedback, 'session', '2026-08-30-came-back', {
      frontmatter: { status: 'fixed', closed_at: '2026-09-04T00:00:00.000Z' },
      body: body('Recurrence — 2026-09-06'),
    });
    expect(run(config, 'close', 'user/session/2026-08-30-came-back.md', '--fixed', 'abc1234').status).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('fixed_by: abc1234');
    expect(JSON.parse(run(config, 'list').stdout).groups).toEqual([]);
    expect(
      run(config, 'close', 'user/session/2026-08-30-came-back.md', '--fixed', 'abc1234').stderr,
    ).toContain('already closed');
  });

  it('falls back to the committer date of applied_sha', () => {
    const { repo, feedback, config } = workspace();
    writeFileSync(join(repo, 'skills', 'x.md'), 'x\n');
    git(repo, 'add', 'skills/x.md');
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'fix'], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
        GIT_AUTHOR_DATE: '2026-09-01T12:00:00Z',
        GIT_COMMITTER_DATE: '2026-09-01T12:00:00Z',
      },
    });
    const sha = git(repo, 'rev-parse', 'HEAD');
    card(feedback, 'demo', '2026-08-20-by-sha', {
      frontmatter: { status: 'fixed', applied_sha: sha },
      body: body('Recurrence — 2026-09-01', 'Recurrence — 2026-09-02'),
    });
    card(feedback, 'demo', '2026-08-20-unknown-sha', {
      frontmatter: { status: 'fixed', applied_sha: 'deadbeef' },
      body: body('Recurrence — 2026-09-02'),
    });
    const doctor = run(config, 'doctor').stdout;
    expect(doctor).toContain('fixed on 2026-09-01 (applied_sha) and recurred 1× after: 2026-09-02');
    expect(doctor).not.toContain('unknown-sha');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSuggestion } from '../src/suggestion.mjs';
import { card, cleanup, run, workspace, write } from './helpers.mjs';

afterEach(cleanup);

const BODY = '# changelog path moved\n\n## Context\n\nc\n\n## Suggestion\n\ns\n\n## Evidence\n\ne\n';
const cli = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'scripts', 'cli.mjs');

function capture(ws, { skill = 'demo', scope = 'demo/SKILL.md', slug, body = BODY, extra = [] }) {
  const file = write(join(ws.root, `${slug}.body.md`), body);
  return run(
    ws.config,
    'capture',
    '--write',
    '--skill',
    skill,
    '--scope',
    scope,
    '--slug',
    slug,
    '--severity',
    'high',
    '--outcome',
    'partial',
    '--date',
    '2026-11-20',
    '--context-file',
    file,
    ...extra,
  );
}

describe('kaizen capture --write', () => {
  it('writes a new capture with the frontmatter the parser reads and prints its path', () => {
    const ws = workspace();
    const result = capture(ws, { slug: 'changelog-path-moved' });
    const file = join(ws.feedback, 'demo', '2026-11-20-changelog-path-moved.md');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`Reflection: ${file}\n`);
    const text = readFileSync(file, 'utf8');
    expect(text).toBe(
      '---\nskill: demo\ndate: 2026-11-20\noutcome: partial\nseverity: high\nscope: demo/SKILL.md\nstatus: open\n---\n\n' +
        BODY,
    );
    const item = parseSuggestion({ id: 'user/demo/x.md', file, skill: 'demo', target: 'user', text });
    expect(item).toMatchObject({
      status: 'open',
      severity: 'high',
      scope: 'demo/SKILL.md',
      date: '2026-11-20',
      slug: 'changelog-path-moved',
      context: 'c',
      suggestion: 's',
      evidence: 'e',
      recurrences: 0,
    });
    expect(JSON.parse(run(ws.config, 'list').stdout).groups[0].items[0].file).toBe(file);
  });

  it('appends a dated Recurrence to an open match instead of writing a second file', () => {
    const ws = workspace();
    const open = card(ws.feedback, 'demo', '2026-11-01-changelog-path-moved-again', {
      frontmatter: { scope: 'demo/SKILL.md' },
    });
    const before = readFileSync(open, 'utf8');
    const result = capture(ws, { slug: 'other-topic' });
    expect(result.stdout).toBe(`Reflection: appended to ${open}\n`);
    expect(readdirSync(join(ws.feedback, 'demo'))).toEqual(['2026-11-01-changelog-path-moved-again.md']);
    const text = readFileSync(open, 'utf8');
    expect(text.startsWith(before.trimEnd())).toBe(true);
    expect(text).toContain('## Recurrence — 2026-11-20\n\n### changelog path moved\n\n### Context\n\nc');
    expect(text.match(/^## /gm)).toHaveLength(4);
    const item = parseSuggestion({ id: 'x', file: open, skill: 'demo', target: 'user', text });
    expect(item).toMatchObject({ recurrences: 1, recurrenceDates: ['2026-11-20'], context: 'c' });
  });

  it('appends to a fixed lookalike, which list then resurfaces as recurred after fix', () => {
    const ws = workspace();
    const fixed = card(ws.feedback, 'other', '2026-11-01-gh-pr-edit-blocked-by-projects', {
      frontmatter: { scope: 'lib/pr/edit.sh', status: 'fixed', closed_at: '2026-11-02T00:00:00Z' },
    });
    const result = capture(ws, { slug: 'gh-pr-edit-projects-classic-blocked', scope: 'x.md' });
    expect(result.stdout).toBe(`Reflection: appended to ${fixed}\n`);
    const listed = JSON.parse(run(ws.config, 'list').stdout).groups[0].items[0];
    expect(listed.recurredAfterFix).toMatchObject({ fixedOn: '2026-11-02', dates: ['2026-11-20'] });
  });

  it('--new writes a separate file even when a match exists, never overwriting one', () => {
    const ws = workspace();
    card(ws.feedback, 'demo', '2026-11-20-changelog-path-moved', { frontmatter: { scope: 'demo/SKILL.md' } });
    const result = capture(ws, { slug: 'changelog-path-moved', extra: ['--new'] });
    const file = join(ws.feedback, 'demo', '2026-11-20-changelog-path-moved-2.md');
    expect(result.stdout).toBe(`Reflection: ${file}\n`);
    expect(existsSync(file)).toBe(true);
  });

  it('reads the body from stdin', () => {
    const ws = workspace();
    const result = spawnSync(
      'node',
      [cli, 'capture', '--write', '--skill', 'demo', '--scope', 'demo/SKILL.md', '--slug', 'from-stdin-body'],
      {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, KAIZEN_CONFIG: ws.config },
        input: BODY,
        encoding: 'utf8',
      },
    );
    // Severity and outcome are required, so this run must fail before reading anything.
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^capture --write: missing --severity\n/);
    const ok = spawnSync(
      'node',
      [
        cli,
        'capture',
        '--write',
        '--skill=demo',
        '--scope=demo/SKILL.md',
        '--slug=from-stdin-body',
        '--severity=low',
        '--outcome=complete',
        '--date=2026-11-20',
      ],
      {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, KAIZEN_CONFIG: ws.config },
        input: BODY,
        encoding: 'utf8',
      },
    );
    const file = join(ws.feedback, 'demo', '2026-11-20-from-stdin-body.md');
    expect(ok.stdout).toBe(`Reflection: ${file}\n`);
    expect(readFileSync(file, 'utf8')).toContain('severity: low\n');
  });

  it.each([
    [{ slug: 'Bad Slug' }, /--slug must be lowercase dash-separated words/],
    [
      { slug: 'no-evidence', body: '## Context\n\nc\n\n## Suggestion\n\ns\n' },
      /non-empty ## Evidence section/,
    ],
    [
      { slug: 'empty-sections', body: '## Context\n\n## Suggestion\n\n## Evidence\n\ne\n' },
      /non-empty ## Context, ## Suggestion section/,
    ],
    [{ slug: 'has-frontmatter', body: `---\nskill: x\n---\n${BODY}` }, /must not carry frontmatter/],
  ])('rejects invalid input %#', (input, message) => {
    const ws = workspace();
    const result = capture(ws, input);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(result.stdout).toBe('');
    expect(existsSync(join(ws.feedback, 'demo'))).toBe(false);
  });

  it('rejects a severity or outcome outside the contract', () => {
    const ws = workspace();
    const file = write(join(ws.root, 'body.md'), BODY);
    const base = [
      'capture',
      '--write',
      '--skill',
      'demo',
      '--scope',
      'a.md',
      '--slug',
      'x-y',
      '--context-file',
      file,
    ];
    expect(run(ws.config, ...base, '--severity', 'urgent', '--outcome', 'partial').stderr).toMatch(
      /--severity must be one of low, medium, high: urgent/,
    );
    expect(run(ws.config, ...base, '--severity', 'low', '--outcome', 'done').stderr).toMatch(
      /--outcome must be one of complete, partial, errored: done/,
    );
  });

  it('writes into the target that holds the skill', () => {
    const ws = workspace();
    const second = join(ws.root, 'second');
    write(join(second, 'skills', 'tool', 'SKILL.md'), '# tool\n');
    const config = JSON.parse(readFileSync(ws.config, 'utf8'));
    config.targets.push({ name: 'proj', skills: join(second, 'skills'), feedback: join(second, 'feedback') });
    write(ws.config, JSON.stringify(config));
    const result = capture(ws, { skill: 'tool', scope: 'tool/SKILL.md', slug: 'second-target-capture' });
    expect(result.stdout).toBe(
      `Reflection: ${join(second, 'feedback', 'tool', '2026-11-20-second-target-capture.md')}\n`,
    );
  });
});

describe('kaizen capture --check usage', () => {
  it('names the missing flag', () => {
    const { config } = workspace();
    const reason = (...args) => JSON.parse(run(config, 'capture', ...args).stdout).reason;
    expect(reason('--check', '--skill', 'demo', '--scope', 'a.md')).toMatch(/^missing --slug; usage: /);
    expect(reason('--check', '--skill', 'demo', '--slug', 'a-b')).toMatch(/^missing --scope; usage: /);
    expect(reason('--skill', 'demo')).toMatch(/^missing --check or --write; usage: /);
  });
});

describe('kaizen show', () => {
  it('prints one scope group in full, Recurrence sections included, and nothing from other groups', () => {
    const ws = workspace();
    const first = card(ws.feedback, 'demo', '2026-11-01-first-item', {
      frontmatter: { scope: 'skills/demo/SKILL.md', severity: 'high' },
      body: '## Context\n\nc1\n\n## Suggestion\n\ns1\n\n## Evidence\n\ne1\n\n## Recurrence — 2026-11-05\n\nagain',
    });
    const second = card(ws.feedback, 'demo', '2026-11-02-second-item', {
      frontmatter: { scope: 'skills/demo/SKILL.md', severity: 'low' },
    });
    card(ws.feedback, 'demo', '2026-11-03-elsewhere', { frontmatter: { scope: 'skills/lib/other.md' } });
    const index = run(ws.config, 'list', '--by', 'scope', '--text').stdout;
    expect(index).toContain('skills/demo/SKILL.md (2)');
    const result = run(ws.config, 'show', '--scope', 'skills/demo/SKILL.md');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      [
        'skills/demo/SKILL.md (2)',
        '',
        '==> user/demo/2026-11-01-first-item.md [high] <==',
        `file: ${first}`,
        '',
        readFileSync(first, 'utf8').trimEnd(),
        '',
        '==> user/demo/2026-11-02-second-item.md [low] <==',
        `file: ${second}`,
        '',
        readFileSync(second, 'utf8').trimEnd(),
        '',
      ].join('\n'),
    );
    expect(result.stdout).not.toContain('elsewhere');
    const json = JSON.parse(run(ws.config, 'show', '--scope', 'skills/demo/SKILL.md', '--json').stdout);
    expect(json.items.map((item) => [item.id, item.recurrences])).toEqual([
      ['user/demo/2026-11-01-first-item.md', 1],
      ['user/demo/2026-11-02-second-item.md', 0],
    ]);
    expect(json.items[0].text).toContain('## Recurrence — 2026-11-05\n\nagain');
  });

  it('fails on an unknown key and without a key', () => {
    const ws = workspace();
    card(ws.feedback, 'demo', '2026-11-01-first-item', { frontmatter: { scope: 'skills/demo/SKILL.md' } });
    const unknown = run(ws.config, 'show', '--scope', 'nope.md');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/no open group with scope key nope.md/);
    expect(run(ws.config, 'show').stderr).toMatch(/^usage: kaizen show/);
    expect(run(ws.config, 'show', '--skill', 'demo').stdout).toContain('first-item.md');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'scripts', 'cli.mjs');
const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kaizen-lite-'));
  roots.push(root);
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  mkdirSync(join(root, 'feedback', 'demo'), { recursive: true });
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '# Demo\n');
  const config = join(root, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      targets: [{ name: 'user', skills: join(root, 'skills'), feedback: join(root, 'feedback') }],
    }),
  );
  return { root, config };
}

function card(root, slug, { status, scope = 'demo/SKILL.md', severity = 'medium', extra = '', body } = {}) {
  const file = join(root, 'feedback', 'demo', `2026-01-01-${slug}.md`);
  writeFileSync(
    file,
    [
      '---',
      'skill: demo',
      'date: 2026-01-01',
      `severity: ${severity}`,
      `scope: ${scope}`,
      ...(status === undefined ? [] : [`status: ${status}`]),
      ...(extra ? extra.trim().split('\n') : []),
      '---',
      '',
      body ?? '## Context\n\ncontext\n\n## Suggestion\n\nsuggestion\n\n## Evidence\n\nevidence',
      '',
    ].join('\n'),
  );
  return file;
}

function run(config, ...args) {
  const stdoutPath = join(config + '.stdout');
  const stderrPath = join(config + '.stderr');
  const stdout = openSync(stdoutPath, 'w');
  const stderr = openSync(stderrPath, 'w');
  const result = spawnSync('node', [cli, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, KAIZEN_CONFIG: config },
    stdio: ['ignore', stdout, stderr],
  });
  closeSync(stdout);
  closeSync(stderr);
  return {
    status: result.status,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('kaizen list', () => {
  it('groups open items as the exact agent JSON shape and finds a sibling patch', () => {
    const { root, config } = fixture();
    const open = card(root, 'open-item');
    writeFileSync(open.replace(/\.md$/, '.patch'), 'diff --git a/x b/x\n');
    card(root, 'fixed-item', { status: 'fixed' });
    const result = run(config, 'list', '--by', 'scope');
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(Object.keys(output)).toEqual(['generatedAt', 'groups']);
    expect(output.groups).toHaveLength(1);
    expect(output.groups[0].key).toBe('demo/SKILL.md');
    expect(output.groups[0].items[0]).toEqual({
      id: 'user/demo/2026-01-01-open-item.md',
      file: open,
      skill: 'demo',
      target: 'user',
      status: 'open',
      recurredAfterFix: null,
      scope: 'demo/SKILL.md',
      severity: 'medium',
      date: '2026-01-01',
      slug: 'open-item',
      recurrences: 0,
      context: 'context',
      suggestion: 'suggestion',
      evidence: 'evidence',
      patch: open.replace(/\.md$/, '.patch'),
    });
  });

  it('--missing-from reports open ids absent from a deck and exits 1 until all are covered', () => {
    const { root, config } = fixture();
    card(root, 'in-deck');
    card(root, 'left-out');
    card(root, 'closed', { status: 'fixed' });
    const deck = join(root, 'deck.html');
    writeFileSync(deck, '<li data-id="user/demo/2026-01-01-in-deck.md">fix</li>');
    const partial = run(config, 'list', '--missing-from', deck);
    expect(partial.status).toBe(1);
    expect(JSON.parse(partial.stdout)).toEqual({ missing: ['user/demo/2026-01-01-left-out.md'] });
    writeFileSync(deck, 'user/demo/2026-01-01-in-deck.md user/demo/2026-01-01-left-out.md', { flag: 'a' });
    const complete = run(config, 'list', '--missing-from', deck, '--text');
    expect(complete.status).toBe(0);
    expect(complete.stdout).toBe('');
  });
});

describe('kaizen close', () => {
  it('closes a batch and records its resolution', () => {
    const { root, config } = fixture();
    const one = card(root, 'one');
    const two = card(root, 'two');
    const result = run(
      config,
      'close',
      'user/demo/2026-01-01-one.md',
      'user/demo/2026-01-01-two.md',
      '--fixed',
      'abc123',
    );
    expect(result.status).toBe(0);
    for (const file of [one, two]) {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('status: fixed');
      expect(text).toContain('fixed_by: abc123');
      expect(text).toMatch(/closed_at: \d{4}-\d{2}-\d{2}T/);
      expect(text).toContain('## Resolution\n\nFixed by `abc123`.');
    }
  });

  it('is all-or-nothing when any id is unknown', () => {
    const { root, config } = fixture();
    const file = card(root, 'known');
    const before = readFileSync(file, 'utf8');
    const result = run(
      config,
      'close',
      'user/demo/2026-01-01-known.md',
      'user/demo/missing.md',
      '--dropped',
      'one-off',
    );
    expect(result.status).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('accepts mixed fixed and dropped decisions as JSON', () => {
    const { root, config } = fixture();
    const fixed = card(root, 'fixed');
    const dropped = card(root, 'dropped');
    const decisions = join(root, 'close.json');
    writeFileSync(
      decisions,
      JSON.stringify([
        { id: 'user/demo/2026-01-01-fixed.md', fixed: 'deadbee' },
        { id: 'user/demo/2026-01-01-dropped.md', dropped: 'wrong premise' },
      ]),
    );
    expect(run(config, 'close', '--json', decisions).status).toBe(0);
    expect(readFileSync(fixed, 'utf8')).toContain('fixed_by: deadbee');
    expect(readFileSync(dropped, 'utf8')).toContain('dropped_reason: wrong premise');
  });
});

describe('kaizen migrate', () => {
  it('maps every legacy status and removes lifecycle-only fields', () => {
    const { root, config } = fixture();
    const cases = [
      ['verified', 'fixed', 'applied_sha: a1'],
      ['superseded', 'dropped', '', '## Verdict\n\ncovered elsewhere\nmore'],
      ['rejected', 'dropped', '', '## Answer\n\nnot desired'],
      ['applied', 'fixed', 'applied_sha: a2'],
      ['reviewed', 'fixed', 'applied_sha: a3'],
      ['reviewed-no-sha', 'open', ''],
      ['recorded', 'open', 'needs_review: codex\ntype: tooling\nobjective: speed\nrung: 1\neffort: S'],
    ];
    const files = cases.map(([legacy, , extra, body], index) =>
      card(root, `case-${index}`, {
        status: legacy === 'reviewed-no-sha' ? 'reviewed' : legacy,
        extra,
        body: body ?? '## Context\n\nc\n\n## Suggestion\n\ns',
      }),
    );
    const preview = run(config, 'migrate', '--dry-run');
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain('verified -> fixed: 1');
    expect(readFileSync(files[0], 'utf8')).toContain('status: verified');
    expect(run(config, 'migrate').status).toBe(0);
    cases.forEach(([, expected], index) =>
      expect(readFileSync(files[index], 'utf8')).toContain(`status: ${expected}`),
    );
    expect(readFileSync(files[0], 'utf8')).toContain('fixed_by: a1');
    expect(readFileSync(files[1], 'utf8')).toContain('dropped_reason: covered elsewhere');
    expect(readFileSync(files[2], 'utf8')).toContain('dropped_reason: not desired');
    expect(readFileSync(files[6], 'utf8')).not.toMatch(/needs_review:|type:|objective:|rung:|effort:/);
  });
});

describe('kaizen prune', () => {
  it('uses closed_at and deletes a stale sidecar only outside dry-run', () => {
    const { root, config } = fixture();
    const old = card(root, 'old', { status: 'fixed', extra: 'closed_at: 2020-01-01T00:00:00.000Z' });
    const patch = old.replace(/\.md$/, '.patch');
    writeFileSync(patch, 'old patch');
    const fresh = card(root, 'fresh', { status: 'dropped', extra: `closed_at: ${new Date().toISOString()}` });
    expect(run(config, 'prune', '--days', '30', '--dry-run').stdout).toContain('would prune 1 closed');
    expect(existsSync(old)).toBe(true);
    expect(run(config, 'prune', '--days', '30').stdout).toContain('pruned 1 closed');
    expect(existsSync(old)).toBe(false);
    expect(existsSync(patch)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe('kaizen status', () => {
  it('prints only the open count, never a category', () => {
    const { root, config } = fixture();
    card(root, 'one');
    card(root, 'two', { status: 'unknown-old-status' });
    card(root, 'done', { status: 'fixed' });
    expect(run(config, 'status').stdout.trim()).toBe('kaizen: 2 open');
    expect(run(config, 'status', '--bar').stdout.trim()).toBe('改 ○2');
  });
});

describe('kaizen capture --check', () => {
  it('keeps the normalized-scope dedupe contract', () => {
    const { root, config } = fixture();
    const existing = card(root, 'existing-item');
    const result = run(
      config,
      'capture',
      '--check',
      '--skill',
      'demo',
      '--scope',
      join(root, 'skills', 'demo', 'SKILL.md'),
      '--slug',
      'another-item',
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).match).toBe(existing);
  });
});

describe('scopePath', () => {
  it('resolves a relative scope against the repo root that owns the skills dir', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { scopePath } = await import('../src/scan.mjs');
    const repo = mkdtempSync(join(tmpdir(), 'kaizen-scope-'));
    execFileSync('git', ['init', '-q', repo]);
    mkdirSync(join(repo, 'skills'));
    const target = { skills: join(repo, 'skills') };
    expect(scopePath({ scope: 'scripts/cli.mjs' }, target)).toBe(join(repo, 'scripts/cli.mjs'));
    expect(scopePath({ scope: '/abs/x.md' }, target)).toBe('/abs/x.md');
  });

  it('strips trailing notes and finds paths written relative to the skills dir or the repo parent', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { basename, join } = await import('node:path');
    const { scopePath, scopeKey } = await import('../src/scan.mjs');
    const repo = mkdtempSync(join(tmpdir(), 'kaizen-scope-'));
    execFileSync('git', ['init', '-q', repo]);
    mkdirSync(join(repo, 'skills', 'demo'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'demo', 'SKILL.md'), '');
    const target = { name: 't', skills: join(repo, 'skills') };
    const file = join(repo, 'skills', 'demo', 'SKILL.md');
    expect(scopePath({ scope: 'skills/demo/SKILL.md §1.3' }, target)).toBe(file);
    expect(scopePath({ scope: 'demo/SKILL.md (why)' }, target)).toBe(file);
    expect(scopePath({ scope: `${basename(repo)}/skills/demo/SKILL.md` }, target)).toBe(file);
    const keys = ['skills/demo/SKILL.md', 'demo/SKILL.md §1.3', file].map((scope) =>
      scopeKey({ scope, target: 't' }, [target]),
    );
    expect(new Set(keys)).toEqual(new Set(['skills/demo/SKILL.md']));
  });
});

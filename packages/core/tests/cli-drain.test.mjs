/**
 * `kaizen drain` — the one-call walk to verified. Lives beside cli-status for
 * the same reason it does: the only .mjs vitest harness that reaches the CLI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'scripts', 'cli.mjs');
let root;

const run = (stamps) => {
  const cfg = join(root, 'config.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      targets: [{ name: 'user', skills: join(root, 'skills'), feedback: join(root, 'feedback') }],
    }),
  );
  writeFileSync(join(root, 'stamps.json'), JSON.stringify(stamps));
  return execFileSync('node', [cli, 'drain', '--apply', join(root, 'stamps.json')], {
    encoding: 'utf8',
    env: { ...process.env, KAIZEN_CONFIG: cfg },
  });
};

const FILE = () => join(root, 'feedback', 'demo', '2026-01-01-walkable.md');
const SHA = 'a'.repeat(40);

const suggestion = (status, { plan = true } = {}) =>
  [
    '---',
    'skill: demo',
    'date: 2026-01-01',
    'severity: low',
    'type: content',
    'objective: bug',
    'scope: demo/SKILL.md',
    'rung: 2',
    'effort: S',
    `status: ${status}`,
    'confirmed_at: 2026-01-01 @ abc1234',
    '---',
    '',
    '## Context',
    '',
    'It happened.',
    '',
    '## Suggestion',
    '',
    'Fix it.',
    '',
    '## Why it matters',
    '',
    'It costs.',
    '',
    '## Evidence',
    '',
    'file:1',
    ...(plan ? ['', '## Plan', '', 'The edit.', '', '## Validation', '', 'grep returns 1.'] : []),
    '',
  ].join('\n');

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kaizen-drain-'));
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  mkdirSync(join(root, 'feedback', 'demo'), { recursive: true });
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n# demo\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('kaizen drain', () => {
  it('walks a planned suggestion to verified with both stamps', () => {
    writeFileSync(FILE(), suggestion('planned'));
    writeFileSync(FILE().replace(/\.md$/, '.patch'), 'diff --git a/x b/x\n');
    const out = run([
      { id: 'user/demo/2026-01-01-walkable.md', sha: SHA, verified_at: '2026-01-01 — grep 1' },
    ]);
    expect(out).toMatch(/stamped 1/);
    const text = readFileSync(FILE(), 'utf8');
    expect(text).toContain('status: verified');
    expect(text).toContain(`applied_sha: ${SHA}`);
    expect(text).toContain('verified_at: 2026-01-01 — grep 1');
  });

  it('refuses a walk whose phases lack their requirements', () => {
    writeFileSync(FILE(), suggestion('triaged', { plan: false }));
    rmSync(FILE().replace(/\.md$/, '.patch'), { force: true });
    expect(() => run([{ id: 'user/demo/2026-01-01-walkable.md', sha: SHA, verified_at: 'x' }])).toThrow(
      /missing plan|missing validation|missing patch/,
    );
    // All-or-nothing: the refusal left the file untouched.
    expect(readFileSync(FILE(), 'utf8')).toContain('status: triaged');
  });

  it('refuses a terminal start and a missing verified_at', () => {
    writeFileSync(FILE(), suggestion('rejected'));
    expect(() => run([{ id: 'user/demo/2026-01-01-walkable.md', sha: SHA, verified_at: 'x' }])).toThrow(
      /cannot reach verified/,
    );
    writeFileSync(FILE(), suggestion('planned'));
    expect(() => run([{ id: 'user/demo/2026-01-01-walkable.md', sha: SHA }])).toThrow(/verified_at/);
  });
});

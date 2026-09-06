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
import { patchIdentity } from '../src/suggestion.mjs';

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

const suggestion = (status, { plan = true, review = true, approvedPatch = '' } = {}) =>
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
    ...(approvedPatch ? [`approved_patch: ${approvedPatch}`] : []),
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
    // The walk passes through `reviewed`, whose phase insists on a write-up:
    // a hand drain owes the same review an unattended one would have made.
    ...(review ? ['', '## Review', '', 'Read the commit; grep returned 1.'] : []),
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
  it('walks an approved suggestion to verified with both stamps', () => {
    const patch = 'diff --git a/x b/x\n';
    writeFileSync(FILE(), suggestion('approved', { approvedPatch: patchIdentity(patch) }));
    writeFileSync(FILE().replace(/\.md$/, '.patch'), patch);
    const out = run([
      { id: 'user/demo/2026-01-01-walkable.md', sha: SHA, verified_at: '2026-01-01 — grep 1' },
    ]);
    expect(out).toMatch(/stamped 1/);
    const text = readFileSync(FILE(), 'utf8');
    expect(text).toContain('status: verified');
    expect(text).toContain(`applied_sha: ${SHA}`);
    expect(text).toContain('verified_at: 2026-01-01 — grep 1');
  });

  it('closes the members carried by the verified suggestion', () => {
    const patch = 'diff --git a/x b/x\n';
    writeFileSync(FILE(), suggestion('approved', { approvedPatch: patchIdentity(patch) }));
    writeFileSync(FILE().replace(/\.md$/, '.patch'), patch);
    const member = join(root, 'feedback', 'demo', '2026-01-02-member.md');
    writeFileSync(
      member,
      suggestion('triaged').replace(
        'confirmed_at: 2026-01-01 @ abc1234',
        'confirmed_at: 2026-01-01 @ abc1234\nblocked_on: carried by 2026-01-01-walkable',
      ),
    );

    run([{ id: 'user/demo/2026-01-01-walkable.md', sha: SHA, verified_at: '2026-01-01 — grep 1' }]);
    const text = readFileSync(member, 'utf8');
    expect(text).toContain('status: superseded');
    expect(text).toContain(`superseded_by: ${SHA}`);
    rmSync(member);
  });

  it('refuses an approved suggestion whose sidecar no longer matches its approval', () => {
    const approved = 'diff --git a/x b/x\n';
    writeFileSync(FILE(), suggestion('approved', { approvedPatch: patchIdentity(approved) }));
    writeFileSync(FILE().replace(/\.md$/, '.patch'), 'diff --git a/y b/y\n');

    expect(() =>
      run([{ id: 'user/demo/2026-01-01-walkable.md', sha: SHA, verified_at: '2026-01-01 — grep 1' }]),
    ).toThrow(/approved patch identity does not match/);
    expect(readFileSync(FILE(), 'utf8')).toContain('status: approved');
  });

  it('refuses a walk whose phases lack their requirements', () => {
    writeFileSync(FILE(), suggestion('triaged', { plan: false }));
    rmSync(FILE().replace(/\.md$/, '.patch'), { force: true });
    expect(() => run([{ id: 'user/demo/2026-01-01-walkable.md', sha: SHA, verified_at: 'x' }])).toThrow(
      /missing plan|missing validation|missing patch/,
    );
    // All-or-nothing: the refusal left the file untouched.
    expect(readFileSync(FILE(), 'utf8')).toContain('status: triaged');

    // `reviewed` sits on the way to `verified` now, and its phase wants the
    // review written down — a drain that skipped it would claim a second pair
    // of eyes that never looked.
    writeFileSync(FILE(), suggestion('planned', { review: false }));
    writeFileSync(FILE().replace(/\.md$/, '.patch'), 'diff --git a/x b/x\n');
    expect(() => run([{ id: 'user/demo/2026-01-01-walkable.md', sha: SHA, verified_at: 'x' }])).toThrow(
      /cannot pass "reviewed" — missing review/,
    );
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

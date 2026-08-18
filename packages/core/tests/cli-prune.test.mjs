/**
 * `kaizen prune` — the corpus stays small: closed and untouched for a month
 * is history. Beside the other CLI tests, for the same harness.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'scripts', 'cli.mjs');
let root;

const run = (...args) => {
  const cfg = join(root, 'config.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      targets: [{ name: 'user', skills: join(root, 'skills'), feedback: join(root, 'feedback') }],
    }),
  );
  return execFileSync('node', [cli, 'prune', ...args], {
    encoding: 'utf8',
    env: { ...process.env, KAIZEN_CONFIG: cfg },
  });
};

/** A file dated `days` ago — the board's age, and prune's, is the filed date. */
const file = (slug, status, days) => {
  const date = new Date(Date.now() - days * 86400000).toLocaleDateString('sv');
  const path = join(root, 'feedback', 'demo', `${date}-${slug}.md`);
  writeFileSync(
    path,
    `---\nskill: demo\ndate: ${date}\nseverity: low\nstatus: ${status}\n---\n\n## Context\n\nc\n`,
  );
  return path;
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kaizen-prune-'));
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  mkdirSync(join(root, 'feedback', 'demo'), { recursive: true });
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '# demo\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('kaizen prune', () => {
  it('removes closed suggestions older than a month, with their patch, and nothing else', () => {
    const oldRejected = file('old-rejected', 'rejected', 45);
    const oldPatch = oldRejected.replace(/\.md$/, '.patch');
    writeFileSync(oldPatch, 'diff\n');
    const oldVerified = file('old-verified', 'verified', 31);
    const freshClosed = file('fresh-superseded', 'superseded', 29);
    const oldOpen = file('old-but-open', 'triaged', 200);

    const preview = run('--dry-run');
    expect(preview).toMatch(/would prune 2 closed/);
    expect(existsSync(oldRejected)).toBe(true);

    const out = run();
    expect(out).toMatch(/pruned 2 closed/);
    expect(existsSync(oldRejected)).toBe(false);
    expect(existsSync(oldPatch)).toBe(false);
    expect(existsSync(oldVerified)).toBe(false);
    expect(existsSync(freshClosed)).toBe(true);
    expect(existsSync(oldOpen)).toBe(true);
    // A second pass finds nothing — and says so rather than erroring.
    expect(run()).toMatch(/pruned 0 closed/);
  });
});

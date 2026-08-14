/**
 * `kaizen doctor --file` — filing without burying. Lives beside cli-status for
 * the same reason it does: the only .mjs vitest harness that reaches the CLI.
 *
 * Both cases are the defect of the 2026-08-13 pass: dedup keyed on
 * `<date>-<slug>` refiled five findings that were already open under
 * yesterday's date, and the date itself was UTC — an evening run stamped
 * files with tomorrow.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'scripts', 'cli.mjs');
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kaizen-doctor-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  mkdirSync(join(root, 'feedback', 'session'), { recursive: true });
  // An approved suggestion with no patch beside it fires decided-without-a-patch
  // deterministically — a state-only check, blind to this machine's contents.
  writeFileSync(
    join(root, 'feedback', 'session', '2026-08-01-stuck.md'),
    [
      '---',
      'skill: session',
      'date: 2026-08-01',
      'severity: low',
      'type: content',
      'objective: bug',
      'scope: demo/SKILL.md',
      'rung: 2',
      'effort: S',
      'status: approved',
      '---',
      '',
      '## Context',
      '',
      'It happened.',
      '',
    ].join('\n'),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (tz) => {
  const cfg = join(root, 'config.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      targets: [
        { name: 'user', skills: join(root, 'skills'), feedback: join(root, 'feedback'), writable: true },
      ],
    }),
  );
  return execFileSync('node', [cli, 'doctor', '--file'], {
    encoding: 'utf8',
    env: { ...process.env, KAIZEN_CONFIG: cfg, ...(tz ? { TZ: tz } : {}) },
  });
};

const kaizenDir = () => join(root, 'feedback', 'kaizen');
const filedAbout = (slug) => readdirSync(kaizenDir()).filter((f) => f.endsWith(`-${slug}.md`));

describe('kaizen doctor --file', () => {
  it('appends a recurrence to a finding still open under an earlier date instead of refiling it', () => {
    const prior = join(kaizenDir(), '2026-08-05-decisions-with-no-proposal-behind-them.md');
    mkdirSync(kaizenDir(), { recursive: true });
    writeFileSync(
      prior,
      [
        '---',
        'skill: kaizen',
        'date: 2026-08-05',
        'severity: low',
        'type: tooling',
        'objective: guardrail',
        'scope: skills/kaizen/SKILL.md',
        'rung: 1',
        'effort: M',
        'status: recorded',
        '---',
        '',
        '## Context',
        '',
        'Filed on an earlier day, never closed.',
        '',
      ].join('\n'),
    );

    run();

    expect(filedAbout('decisions-with-no-proposal-behind-them')).toEqual([
      '2026-08-05-decisions-with-no-proposal-behind-them.md',
    ]);
    expect(readFileSync(prior, 'utf8')).toMatch(/## Recurrence — \d{4}-\d{2}-\d{2}/);

    // Same day, run again: one recurrence line, not one per run.
    run();
    const sections = readFileSync(prior, 'utf8').match(/## Recurrence — /g);
    expect(sections).toHaveLength(1);
  });

  // At any instant at least one of these two zones disagrees with UTC on what
  // day it is, so a toISOString() regression cannot pass both.
  for (const tz of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
    it(`stamps new findings with the local date (${tz})`, () => {
      run(tz);
      const local = new Date().toLocaleDateString('sv', { timeZone: tz });
      expect(filedAbout('decisions-with-no-proposal-behind-them')).toEqual([
        `${local}-decisions-with-no-proposal-behind-them.md`,
      ]);
    });
  }
});

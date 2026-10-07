import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchIdentity } from '../src/suggestion.mjs';

const cli = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'scripts', 'cli.mjs');
let root;
let config;
let file;
const id = 'user/demo/2026-01-01-changed.md';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kaizen-triage-approved-'));
  const skills = join(root, 'skills');
  const feedback = join(root, 'feedback');
  mkdirSync(join(skills, 'demo'), { recursive: true });
  mkdirSync(join(feedback, 'demo'), { recursive: true });
  writeFileSync(join(skills, 'demo', 'SKILL.md'), '---\nname: demo\n---\n# demo\n');
  config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ targets: [{ name: 'user', skills, feedback }] }));
  file = join(feedback, 'demo', '2026-01-01-changed.md');
  writeFileSync(
    file,
    `---\nskill: demo\ndate: 2026-01-01\nseverity: low\ntype: structural\nobjective: guardrail\neffort: S\nrung: 0\nscope: lifecycle.json\nstatus: approved\napproved_patch: ${patchIdentity('old patch\n')}\n---\n\n## Context\n\nc\n\n## Suggestion\n\ns\n`,
  );
  writeFileSync(file.replace(/\.md$/, '.patch'), 'replacement patch\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (decision, ...args) =>
  spawnSync('node', [cli, 'triage', '--apply', '-', ...args], {
    input: JSON.stringify([decision]),
    encoding: 'utf8',
    env: { ...process.env, KAIZEN_CONFIG: config },
  });

describe('kaizen triage approval invalidation', () => {
  it('requires a changed approved patch to return to checked planning', () => {
    const refused = run({ id, confirmed_at: '2026-01-01 @ abc1234' }, '--dry-run');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/approved patch changed/);
    expect(readFileSync(file, 'utf8')).toMatch(/status: approved/);

    const accepted = run({ id, status: 'planned', needs_review: 'codex' });
    expect(accepted.status).toBe(0);
    expect(readFileSync(file, 'utf8')).toMatch(/status: planned/);
    expect(readFileSync(file, 'utf8')).toMatch(/needs_review: codex/);
    expect(readFileSync(file, 'utf8')).toMatch(/approved_patch:\s*$/m);
  });
});

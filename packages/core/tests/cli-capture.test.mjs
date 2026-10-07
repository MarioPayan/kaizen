/** The capture-time duplicate check, end to end through the real CLI. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'scripts', 'cli.mjs');
let root;
let config;

const card = (slug, { scope = '', status = 'recorded' } = {}) => {
  const path = join(root, 'feedback', 'demo', `2026-01-01-${slug}.md`);
  writeFileSync(
    path,
    `---\nskill: demo\ndate: 2026-01-01\nseverity: low\nstatus: ${status}\n${scope ? `scope: ${scope}\n` : ''}---\n\n## Suggestion\n\ns\n`,
  );
  return path;
};

const check = ({ skill = 'demo', scope = 'other.md', slug = 'unrelated-capture' } = {}) => {
  const result = spawnSync(
    'node',
    [cli, 'capture', '--check', '--skill', skill, '--scope', scope, '--slug', slug],
    { encoding: 'utf8', env: { ...process.env, KAIZEN_CONFIG: config } },
  );
  return { ...result, json: JSON.parse(result.stdout) };
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kaizen-capture-'));
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  mkdirSync(join(root, 'feedback', 'demo'), { recursive: true });
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n# demo\n');
  config = join(root, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      targets: [{ name: 'user', skills: join(root, 'skills'), feedback: join(root, 'feedback') }],
    }),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('kaizen capture --check', () => {
  it('matches an open card with the same normalized scope and exits zero', () => {
    const existing = card('existing-scope', { scope: 'shared/rules.md' });
    const result = check({ scope: join(root, 'skills', 'shared', 'rules.md') });
    expect(result.status).toBe(0);
    expect(result.json).toEqual({
      match: existing,
      reason: 'same normalized scope: shared/rules.md',
    });
  });

  it('matches three shared slug words but ignores terminal cards and other skills', () => {
    const existing = card('validation-error-must-stay-visible');
    card('closed-card-should-not-match', { scope: 'closed.md', status: 'verified' });

    const shared = check({ slug: 'keep-validation-error-visible-now' });
    expect(shared.status).toBe(0);
    expect(shared.json.match).toBe(existing);
    expect(shared.json.reason).toMatch(/shares 3 dash-separated words/);

    const terminal = check({ scope: 'closed.md', slug: 'closed-card-should-not-match' });
    expect(terminal.status).toBe(0);
    expect(terminal.json.match).toBeNull();

    const otherSkill = check({ skill: 'other', slug: 'keep-validation-error-visible-now' });
    expect(otherSkill.status).toBe(0);
    expect(otherSkill.json.match).toBeNull();
  });

  it('self-checks the matching rules', () => {
    const result = spawnSync('node', [cli, 'capture', '--self-check'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('normalized scope finds the open card');
  });
});

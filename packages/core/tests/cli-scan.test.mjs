/**
 * `kaizen scan` fenced to one card. Beside cli-status for the same reason it
 * is: the only .mjs vitest harness that reaches the CLI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'scripts', 'cli.mjs');
let root;

const scan = (...args) => {
  const cfg = join(root, 'config.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      targets: [{ name: 'user', skills: join(root, 'skills'), feedback: join(root, 'feedback') }],
    }),
  );
  return JSON.parse(
    execFileSync('node', [cli, 'scan', ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: root, KAIZEN_CONFIG: cfg },
    }),
  );
};

const card = (skill, slug, scope = '') =>
  writeFileSync(
    join(root, 'feedback', skill, `2026-01-01-${slug}.md`),
    `---\nskill: ${skill}\ndate: 2026-01-01\nseverity: low\n${scope ? `scope: ${scope}\n` : ''}---\n\n## Suggestion\n\ns\n`,
  );

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kaizen-scan-'));
  for (const skill of ['alpha', 'beta']) {
    mkdirSync(join(root, 'skills', skill), { recursive: true });
    mkdirSync(join(root, 'feedback', skill), { recursive: true });
    writeFileSync(join(root, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n# ${skill}\n`);
    card(skill, 'a-thing');
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('kaizen scan', () => {
  it('returns the whole corpus with no fence', () => {
    const state = scan();
    expect(state.suggestions).toHaveLength(2);
    expect(state.skills.map((k) => k.name).sort()).toEqual(['alpha', 'beta']);
  });

  /**
   * A fenced read is fenced on both halves. `--id` used to trim the
   * suggestions and hand back every skill on the machine anyway, and the
   * first runner run got a dump too long to show for the one card it asked
   * for.
   */
  it('fenced to one card, returns that card and its skill only', () => {
    const state = scan('--id', 'user/alpha/2026-01-01-a-thing.md');
    expect(state.suggestions.map((s) => s.skill)).toEqual(['alpha']);
    expect(state.skills.map((k) => k.name)).toEqual(['alpha']);
    const none = scan('--id', 'user/alpha/2026-01-01-nope.md');
    expect(none.suggestions).toEqual([]);
    expect(none.skills).toEqual([]);
  });

  it('collapses relative, tilde, and absolute target-local scopes', () => {
    const relativeScope = 'shared/check.mjs';
    card('alpha', 'relative-scope', relativeScope);
    card('alpha', 'tilde-scope', `~/skills/${relativeScope}`);
    card('alpha', 'absolute-scope', join(root, 'skills', relativeScope));

    const state = scan('--scope', join(root, 'skills', relativeScope));
    expect(state.suggestions).toHaveLength(3);
    expect(state.suggestions.map((s) => s.scope)).toEqual(Array(3).fill(relativeScope));
  });

  it('exposes the latest recurrence when it withdraws the original suggestion', () => {
    writeFileSync(
      join(root, 'feedback', 'alpha', '2026-01-01-a-thing.md'),
      [
        '---',
        'skill: alpha',
        'date: 2026-01-01',
        'severity: low',
        '---',
        '',
        '## Suggestion',
        '',
        'Add the guardrail.',
        '',
        '## Recurrence — 2026-02-01',
        '',
        'Do not add the guardrail; the premise was wrong.',
        '',
        '## Verdict',
        '',
        'Pending triage.',
        '',
      ].join('\n'),
    );

    const state = scan('--id', 'user/alpha/2026-01-01-a-thing.md');
    expect(state.suggestions[0].suggestion).toBe('Add the guardrail.');
    expect(state.suggestions[0].latestRecurrence).toBe(
      '## Recurrence — 2026-02-01\n\nDo not add the guardrail; the premise was wrong.',
    );
  });

  it('exposes the plan and validation for a returned planning pass', () => {
    writeFileSync(
      join(root, 'feedback', 'alpha', '2026-01-01-a-thing.md'),
      [
        '---',
        'skill: alpha',
        'date: 2026-01-01',
        'severity: low',
        '---',
        '',
        '## Plan',
        '',
        'Change the parser and its focused test.',
        '',
        '## Validation',
        '',
        '```bash',
        'npm test -- --run packages/core/tests/cli-scan.test.mjs',
        '```',
        '',
      ].join('\n'),
    );

    const state = scan('--id', 'user/alpha/2026-01-01-a-thing.md');
    expect(state.suggestions[0].plan).toBe('Change the parser and its focused test.');
    expect(state.suggestions[0].validation).toContain(
      'npm test -- --run packages/core/tests/cli-scan.test.mjs',
    );
  });
});

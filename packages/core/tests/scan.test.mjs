import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildState } from '../src/scan.mjs';

const roots = [];

function fixture({ writable = false, scope = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kaizen-scan-warning-'));
  roots.push(root);
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  mkdirSync(join(root, 'feedback', 'demo'), { recursive: true });
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n\n# Demo\n');
  writeFileSync(
    join(root, 'feedback', 'demo', '2026-01-01-finding.md'),
    `---\nskill: demo\ndate: 2026-01-01\n${scope ? `scope: ${scope}\n` : ''}---\n\n## Suggestion\n\ndo it\n`,
  );
  return {
    root,
    config: {
      targets: [
        {
          name: 'user',
          skills: join(root, 'skills'),
          feedback: join(root, 'feedback'),
          writable,
        },
      ],
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('buildState Git warnings', () => {
  it('warns when a writable target is outside Git', () => {
    const { config } = fixture({ writable: true });
    expect(buildState(config).warnings).toEqual([
      expect.stringMatching(
        /^target "user": writable skills path is not inside a Git repository .* cannot advance suggestions past recorded/,
      ),
    ]);
  });

  it('warns when a suggestion scope is outside Git', () => {
    const outside = mkdtempSync(join(tmpdir(), 'kaizen-outside-git-'));
    roots.push(outside);
    const { config } = fixture({ scope: join(outside, 'future', 'check.sh') });
    expect(buildState(config).warnings).toEqual([
      expect.stringMatching(
        /^suggestion "user\/demo\/2026-01-01-finding.md": scope is not inside a Git repository/,
      ),
    ]);
  });

  it('accepts writable targets and relative scopes inside Git', () => {
    const { root, config } = fixture({ writable: true, scope: 'skills/demo/check.sh' });
    execFileSync('git', ['init', '-q'], { cwd: root });
    expect(buildState(config).warnings).toEqual([]);
  });
});

describe('suggestion evidence', () => {
  it('is present in scanner output so a targeted caller needs no second file read', () => {
    const { root, config } = fixture();
    writeFileSync(
      join(root, 'feedback', 'demo', '2026-01-01-finding.md'),
      '---\nskill: demo\ndate: 2026-01-01\n---\n\n## Context\n\nc\n\n## Evidence\n\n- named patch A\n- named patch B\n\n## Suggestion\n\ndo it\n',
    );

    const [finding] = buildState(config).suggestions;
    expect(finding.evidence).toBe('- named patch A\n- named patch B');
  });
});

describe('closedAge', () => {
  /**
   * The board hides finished history by this, so measuring it from the filing
   * date would hide exactly the wrong card: a July finding verified this
   * morning is the freshest thing on the board.
   */
  it('measures a finished card from when it finished, not when it was filed', () => {
    const root = mkdtempSync(join(tmpdir(), 'kaizen-closed-age-'));
    roots.push(root);
    mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
    mkdirSync(join(root, 'feedback', 'demo'), { recursive: true });
    writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n\n# Demo\n');
    const card = (name, status) =>
      writeFileSync(
        join(root, 'feedback', 'demo', name),
        `---\nskill: demo\ndate: 2026-01-01\nstatus: ${status}\n---\n\n## Suggestion\n\ndo it\n`,
      );
    // Both filed the same long-ago day. One is still open; one closed just now,
    // which is what writing the file stamps.
    card('2026-01-01-open.md', 'triaged');
    card('2026-01-01-closed.md', 'verified');

    const config = {
      targets: [{ name: 'user', skills: join(root, 'skills'), feedback: join(root, 'feedback') }],
    };
    const byId = Object.fromEntries(buildState(config).suggestions.map((s) => [s.id.split('/').at(-1), s]));

    expect(byId['2026-01-01-open.md'].age).toBe('older');
    expect(byId['2026-01-01-closed.md'].age).toBe('older');
    // An open card has not closed at all, so it keeps its filing age.
    expect(byId['2026-01-01-open.md'].closedAge).toBe('older');
    expect(byId['2026-01-01-closed.md'].closedAge).toBe('today');
  });
});

describe('skills-dir plugins', () => {
  it('finds skills inside a plugin folder and catalogues lib/ as library', () => {
    const { root, config } = fixture();
    const plugin = join(root, 'skills', 'ts');
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"ts"}');
    mkdirSync(join(plugin, 'skills', 'standup'), { recursive: true });
    writeFileSync(join(plugin, 'skills', 'standup', 'SKILL.md'), '---\nname: standup\n---\n');
    mkdirSync(join(root, 'skills', 'lib', 'github'), { recursive: true });
    writeFileSync(join(root, 'skills', 'lib', 'github', 'README.md'), '# github\n');

    const skills = buildState(config).skills;
    const names = skills.map((s) => s.name);
    expect(names).toContain('standup');
    expect(names).toContain('demo');
    expect(names).not.toContain('ts');
    expect(skills.find((s) => s.name === 'lib/github/README.md')?.kind).toBe('library');
  });
});

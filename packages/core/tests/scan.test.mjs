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

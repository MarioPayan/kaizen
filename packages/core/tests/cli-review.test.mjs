import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'scripts', 'cli.mjs');
const roots = [];

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });

function fixture(validation = 'test "$(cat landed.txt)" = landed') {
  const root = mkdtempSync(join(tmpdir(), 'kaizen-cli-review-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const feedback = `${repo}-feedback`;
  mkdirSync(join(repo, 'skills', 'demo'), { recursive: true });
  mkdirSync(join(feedback, 'demo'), { recursive: true });
  writeFileSync(join(repo, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n# demo\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  writeFileSync(join(repo, 'landed.txt'), 'landed\n');
  git(repo, 'add', 'landed.txt');
  git(repo, 'commit', '-q', '-m', 'landed change');
  const appliedSha = git(repo, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(repo, 'landed.txt'), 'later\n');
  git(repo, 'add', 'landed.txt');
  git(repo, 'commit', '-q', '-m', 'later change');

  const file = join(feedback, 'demo', '2026-01-01-review.md');
  writeFileSync(
    file,
    `---\nskill: demo\ndate: 2026-01-01\nseverity: low\ntype: tooling\nobjective: guardrail\nscope: scripts/cli.mjs\nrung: 1\neffort: S\nstatus: applied\nconfirmed_at: 2026-01-01 @ abc1234\napplied_sha: ${appliedSha}\n---\n\n## Plan\n\nAdd landed.txt.\n\n## Validation\n\n\`\`\`bash\n${validation}\n\`\`\`\n`,
  );
  const config = join(root, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({ targets: [{ name: 'user', skills: join(repo, 'skills'), feedback, writable: true }] }),
  );
  return { config, id: 'user/demo/2026-01-01-review.md', appliedSha };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('kaizen review --dry', () => {
  it('returns the landed diff and validation result from the applied SHA', () => {
    const f = fixture();
    const out = execFileSync('node', [cli, 'review', '--dry', f.id], {
      encoding: 'utf8',
      env: { ...process.env, KAIZEN_CONFIG: f.config },
    });
    const evidence = JSON.parse(out);
    expect(evidence.id).toBe(f.id);
    expect(evidence.sha).toBe(f.appliedSha);
    expect(evidence.diff).toContain('landed change');
    expect(evidence.diff).not.toContain('later change');
    expect(evidence.validation).toMatchObject({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('returns machine-readable failing validation evidence and exits nonzero', () => {
    const f = fixture('echo failure-output\nexit 7');
    const ran = spawnSync('node', [cli, 'review', '--dry', f.id], {
      encoding: 'utf8',
      env: { ...process.env, KAIZEN_CONFIG: f.config },
    });
    expect(ran.status).toBe(1);
    expect(JSON.parse(ran.stdout).validation).toMatchObject({ exitCode: 7, stdout: 'failure-output\n' });
  });
});

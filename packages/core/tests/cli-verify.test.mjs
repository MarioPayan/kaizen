import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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

function fixture(validation) {
  const root = mkdtempSync(join(tmpdir(), 'kaizen-cli-verify-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const feedback = `${repo}-feedback`;
  mkdirSync(join(repo, 'skills', 'demo'), { recursive: true });
  mkdirSync(join(feedback, 'demo'), { recursive: true });
  writeFileSync(join(repo, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n# demo\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');

  const file = join(feedback, 'demo', '2026-01-01-dry.md');
  const command = typeof validation === 'function' ? validation({ file, repo }) : validation;
  writeFileSync(
    file,
    `---\nskill: demo\ndate: 2026-01-01\nseverity: low\ntype: tooling\nobjective: guardrail\nscope: added.txt\nrung: 1\neffort: S\nstatus: planned\nconfirmed_at: 2026-01-01 @ abc1234\n---\n\n## Plan\n\nAdd the file.\n\n## Validation\n\n\`\`\`bash\n${command}\n\`\`\`\n`,
  );
  writeFileSync(
    file.replace(/\.md$/, '.patch'),
    'diff --git a/added.txt b/added.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+hello\n',
  );
  const config = join(root, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({ targets: [{ name: 'user', skills: join(repo, 'skills'), feedback, writable: true }] }),
  );
  return { root, repo, config, id: 'user/demo/2026-01-01-dry.md' };
}

function projectFixture(projects = 1) {
  const f = fixture('test -f "$KAIZEN_TARGET_ROOT/.claude/skills/demo/PROJECT.txt"');
  const projectRoots = [];
  for (let i = 0; i < projects; i++) {
    const project = join(f.root, `project-${i + 1}`);
    mkdirSync(join(project, '.claude', 'skills', 'demo'), { recursive: true });
    writeFileSync(join(project, '.claude', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n# demo\n');
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'init');
    projectRoots.push(project);
  }
  writeFileSync(
    join(f.root, 'repo-feedback', 'demo', '2026-01-01-dry.patch'),
    'diff --git a/.claude/skills/demo/PROJECT.txt b/.claude/skills/demo/PROJECT.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/.claude/skills/demo/PROJECT.txt\n@@ -0,0 +1 @@\n+hello\n',
  );
  writeFileSync(
    f.config,
    JSON.stringify({
      targets: [
        { name: 'user', skills: join(f.repo, 'skills'), feedback: `${f.repo}-feedback`, writable: true },
      ],
      scan: { enabled: true, roots: projectRoots, depth: 1, writable: true },
    }),
  );
  return { ...f, projectRoots };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('kaizen verify --dry', () => {
  it('applies the patch and runs validation only in a throwaway worktree', () => {
    const f = fixture(
      'test -f "$KAIZEN_TARGET_ROOT/added.txt"\necho "refusing to write — 3 problem(s)"\necho fixture-warning >&2',
    );
    const ran = spawnSync('node', [cli, 'verify', '--dry', f.id], {
      encoding: 'utf8',
      env: { ...process.env, KAIZEN_CONFIG: f.config },
    });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('[validation stdout] refusing to write — 3 problem(s)');
    expect(ran.stderr).toContain('[validation stderr] fixture-warning');
    expect(ran.stdout).toContain(`── verify verdict ──\npass ${f.id}`);
    expect(existsSync(join(f.repo, 'added.txt'))).toBe(false);
  });

  it('reports a failing validation and leaves the target untouched', () => {
    const f = fixture('echo validation-output\nexit 7');
    const ran = spawnSync('node', [cli, 'verify', '--dry', f.id], {
      encoding: 'utf8',
      env: { ...process.env, KAIZEN_CONFIG: f.config },
    });
    expect(ran.status).toBe(1);
    expect(ran.stdout).toContain('[validation stdout] validation-output');
    expect(ran.stderr).toContain(`── verify verdict ──\nfail ${f.id} (exit 7)`);
    expect(existsSync(join(f.repo, 'added.txt'))).toBe(false);
  });

  it('reports failure when a non-final validation command fails', () => {
    const f = fixture('false\necho final-command-passed');
    const ran = spawnSync('node', [cli, 'verify', '--dry', f.id], {
      encoding: 'utf8',
      env: { ...process.env, KAIZEN_CONFIG: f.config },
    });
    expect(ran.status).toBe(1);
    expect(ran.stdout).not.toContain('final-command-passed');
    expect(ran.stderr).toContain(`── verify verdict ──\nfail ${f.id} (exit 1)`);
    expect(existsSync(join(f.repo, 'added.txt'))).toBe(false);
  });

  it('rewrites a repository argument without rewriting a sidecar path that shares its prefix', () => {
    const f = fixture(
      ({ file, repo }) => `git -C ${repo} apply --reverse --check ${file.replace(/\.md$/, '.patch')}`,
    );
    const out = execFileSync('node', [cli, 'verify', '--dry', f.id], {
      encoding: 'utf8',
      env: { ...process.env, KAIZEN_CONFIG: f.config },
    });
    expect(out).toContain(`pass ${f.id}`);
  });

  it("verifies a project skill's patch in its discovered project", () => {
    const f = projectFixture();
    const out = execFileSync('node', [cli, 'verify', '--dry', f.id], {
      encoding: 'utf8',
      env: { ...process.env, KAIZEN_CONFIG: f.config },
    });
    expect(out).toContain(`pass ${f.id}`);
    expect(existsSync(join(f.projectRoots[0], '.claude', 'skills', 'demo', 'PROJECT.txt'))).toBe(false);
  });

  it('refuses an ambiguous project skill and names every candidate', () => {
    const f = projectFixture(2);
    const ran = spawnSync('node', [cli, 'verify', '--dry', f.id], {
      encoding: 'utf8',
      env: { ...process.env, KAIZEN_CONFIG: f.config },
    });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('project skill "demo" is ambiguous');
    expect(ran.stderr).toContain(f.projectRoots[0]);
    expect(ran.stderr).toContain(f.projectRoots[1]);
  });
});

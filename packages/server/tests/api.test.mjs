/**
 * The API is what turns a click into a file write, so these cover the refusals
 * rather than the happy paths: reading outside a target, writing to a read-only
 * target, and applying into a tree with uncommitted work in it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '@kaizen/server';

let root;
let server;
let base;
let config;

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

const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaizen-api-'));
  const skills = join(root, 'skills');
  const feedback = join(root, 'skills-feedback');
  const readonly = join(root, 'ro-skills');
  mkdirSync(join(skills, 'demo'), { recursive: true });
  mkdirSync(join(feedback, 'demo'), { recursive: true });
  mkdirSync(readonly, { recursive: true });
  writeFileSync(join(root, 'outside-secret.txt'), 'private');
  writeFileSync(join(skills, 'demo', 'SKILL.md'), '---\nname: demo\n---\n# demo\n');
  writeFileSync(
    join(feedback, 'demo', '2026-01-01-a-thing.md'),
    // `planned` on purpose: approval is reachable only from there, so a fixture
    // sitting at the entry state could not be approved and every apply test
    // below would fail on the transition rather than the guard it is testing.
    '---\nskill: demo\ndate: 2026-01-01\nseverity: medium\neffort: S\nstatus: planned\n---\n\n## Context\n\nc\n\n## Suggestion\n\ns\n',
  );

  git(root, 'init', '-q');
  git(skills, 'init', '-q');
  git(skills, 'add', '-A');
  git(skills, 'commit', '-q', '-m', 'init');

  config = {
    targets: [
      { name: 'user', skills, feedback, writable: true },
      { name: 'ro', skills: readonly, feedback, writable: false },
    ],
    scan: { enabled: false, roots: [], depth: 3, writable: false },
    applyGuards: { requireCleanTree: true, requireDiffApplies: true },
    clusterPromotion: { members: 3, incidents: 5 },
    autoApply: [],
    server: { host: '127.0.0.1', port: 0 },
  };

  server = createApp(config);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

describe('api', () => {
  it('reports health', async () => {
    const { status, body } = await api('GET', '/api/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('builds state from the configured targets', async () => {
    const { body } = await api('GET', '/api/state');
    expect(body.metrics.total).toBe(1);
    expect(body.skills.some((s) => s.name === 'demo')).toBe(true);
  });

  it('renders a skill file that lives inside a target', async () => {
    const { body: state } = await api('GET', '/api/state');
    const skill = state.skills.find((s) => s.name === 'demo');
    const { status, body } = await api('GET', `/api/skill?path=${encodeURIComponent(skill.path)}`);
    expect(status).toBe(200);
    expect(body.content).toContain('# demo');
  });

  it('refuses to read a file outside every target', async () => {
    const outside = join(root, 'outside-secret.txt');
    const { status, body } = await api('GET', `/api/skill?path=${encodeURIComponent(outside)}`);
    expect(status).toBe(403);
    expect(body.error).toMatch(/outside every configured target/);
  });

  it('refuses a traversal id', async () => {
    const { status } = await api('GET', '/api/diff?id=user/../../etc/passwd.md');
    expect(status).toBe(400);
  });

  it('rejects an unknown status', async () => {
    const { status, body } = await api('POST', '/api/suggestion', {
      id: 'user/demo/2026-01-01-a-thing.md',
      status: 'shipped',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/status must be one of/);
  });

  /**
   * The refusal that makes the model load-bearing. A queue of 39 approvals with
   * no patch behind any of them is the state this prevents, and the message has
   * to say where the item is and where it may go — a bare 409 on a button press
   * is indistinguishable from a bug.
   */
  it('refuses a transition the model does not allow, and names the legal ones', async () => {
    const { status, body } = await api('POST', '/api/suggestion', {
      id: 'user/demo/2026-01-01-a-thing.md',
      status: 'verified',
    });
    expect(status).toBe(409);
    expect(body.error).toMatch(/is "planned"/);
    expect(body.error).toMatch(/cannot become "verified"/);
    expect(body.error).toMatch(/approved, rejected/);
  });

  /**
   * The three-hop bypass. Checking only the transition graph let a caller walk
   * `recorded → triaged → planned → approved` and arrive at an approval with no
   * patch and no validation plan behind it — the exact state the model exists to
   * prevent, reached the long way round. A phase's `requires` is now a gate.
   */
  it('refuses a move whose phase has produced nothing, and says what is missing', async () => {
    const id = 'user/demo/2026-01-01-a-thing.md';
    const feedback = config.targets[0].feedback;
    const file = join(feedback, 'demo', '2026-01-01-a-thing.md');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace('status: planned', 'status: triaged'));

    const { status, body } = await api('POST', '/api/suggestion', { id, status: 'planned' });
    expect(status).toBe(409);
    expect(body.error).toMatch(/requires/);
    expect(body.error).toMatch(/plan \(a "## Plan" section\)/);
    expect(body.error).toMatch(/validation/);
    expect(body.error).toMatch(/patch \(a sibling \.patch file\)/);

    writeFileSync(file, original);
  });

  it('refuses to let a caller claim something landed', async () => {
    const { status, body } = await api('POST', '/api/suggestion', {
      id: 'user/demo/2026-01-01-a-thing.md',
      status: 'applied',
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/set by the server/);
  });

  it('records an approval without acting on it', async () => {
    const id = 'user/demo/2026-01-01-a-thing.md';
    const { status } = await api('POST', '/api/suggestion', { id, status: 'approved' });
    expect(status).toBe(200);
    const { body } = await api('GET', '/api/state');
    expect(body.suggestions[0].status).toBe('approved');
    // Approval is a record. Nothing should have been applied by saying yes.
    expect(body.suggestions[0].appliedSha).toBe('');
  });

  it('refuses to apply into a read-only target', async () => {
    const { status, body } = await api('POST', '/api/apply', { id: 'ro/demo/2026-01-01-a-thing.md' });
    expect(status).toBe(403);
    expect(body.error).toMatch(/read-only/);
  });

  it('refuses to apply with no proposal patch', async () => {
    const { status, body } = await api('POST', '/api/apply', { id: 'user/demo/2026-01-01-a-thing.md' });
    expect(status).toBe(422);
    expect(body.error).toMatch(/no proposal patch/);
  });

  it('refuses to apply into a dirty tree', async () => {
    const skills = config.targets[0].skills;
    const feedback = config.targets[0].feedback;
    writeFileSync(join(feedback, 'demo', '2026-01-01-a-thing.patch'), 'not-a-real-patch\n');
    writeFileSync(join(skills, 'demo', 'SKILL.md'), '---\nname: demo\n---\n# demo edited\n');
    const { status, body } = await api('POST', '/api/apply', { id: 'user/demo/2026-01-01-a-thing.md' });
    expect(status).toBe(409);
    expect(body.error).toMatch(/working tree is not clean/);
    // The filename has to be intact. Naming the dirty file is the entire value
    // of this refusal, and a path with its first character shaved off sends the
    // reader looking for something that does not exist.
    expect(body.error).toContain('demo/SKILL.md');
    git(skills, 'checkout', '--', '.');
  });

  it('rejects a revert sha that is not a hash', async () => {
    const { status } = await api('POST', '/api/revert', { sha: '; rm -rf /', target: 'user' });
    expect(status).toBe(400);
  });

  it('404s an unknown api route', async () => {
    const { status } = await api('GET', '/api/nope');
    expect(status).toBe(404);
  });
});

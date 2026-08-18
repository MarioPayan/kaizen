/**
 * The API is what turns a click into a file write, so these cover the refusals
 * rather than the happy paths: reading outside a target, writing to a read-only
 * target, and applying into a tree with uncommitted work in it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '@kaizen/server';

let root;
let server;
let base;
let config;

// Dispatch must never start a real claude run under vitest, so the app gets a
// spawner that only looks like a child process. It records the id it was
// fenced to, which is what the item-scope tests assert on.
const spawned = [];
const fakeClaude = (id) => {
  const child = new EventEmitter();
  child.pid = 4242 + spawned.length;
  child.exitCode = null;
  child.fencedTo = id;
  spawned.push(child);
  process.nextTick(() => child.emit('spawn'));
  return child;
};

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
  // The log route resolves dispatch.log beside configPath() at request time;
  // pointing KAIZEN_CONFIG into the fixture keeps it off the real home dir.
  mkdirSync(join(root, 'kaizen'), { recursive: true });
  process.env.KAIZEN_CONFIG = join(root, 'kaizen', 'config.json');
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

  server = createApp(config, { spawnClaude: fakeClaude });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  delete process.env.KAIZEN_CONFIG;
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

  /**
   * The refusal has to be about the patch, not about the tree. An untracked
   * draft two directories away once held up eleven cards: the guard was
   * whole-tree because the apply staged with `add -A`, so anything lying
   * around would have ridden into the commit. Staging only the patch's own
   * paths is what makes the narrow guard safe.
   */
  it('lands with unrelated work in the tree, and commits only the files the patch names', async () => {
    const skills = config.targets[0].skills;
    const feedback = config.targets[0].feedback;
    writeFileSync(
      join(feedback, 'demo', '2026-06-06-narrow.md'),
      '---\nskill: demo\ndate: 2026-06-06\nseverity: low\ntype: hygiene\nobjective: debt\neffort: S\nrung: 1\nscope: demo/SKILL.md\nstatus: approved\n---\n\n## Context\n\nc\n\n## Suggestion\n\ns\n\n## Plan\n\np\n\n## Validation\n\nv\n',
    );
    const before = git(skills, 'rev-parse', 'HEAD').trim();
    const head = readFileSync(join(skills, 'demo', 'SKILL.md'), 'utf8');
    writeFileSync(
      join(feedback, 'demo', '2026-06-06-narrow.patch'),
      [
        '--- a/demo/SKILL.md',
        '+++ b/demo/SKILL.md',
        '@@ -1,4 +1,5 @@',
        ' ---',
        ' name: demo',
        ' ---',
        ' # demo',
        '+a narrow line',
        '',
      ].join('\n'),
    );
    // The kind of thing that was blocking the queue: untracked, unrelated, and
    // none of the patch's business.
    writeFileSync(join(skills, 'stray-draft.py'), 'print("mine")\n');

    const { status, body } = await api('POST', '/api/apply', { id: 'user/demo/2026-06-06-narrow.md' });
    expect(status).toBe(200);

    const files = git(skills, 'show', '--name-only', '--format=', body.sha).trim().split('\n');
    expect(files).toEqual(['demo/SKILL.md']);
    // Still there, still untracked: the commit did not adopt it.
    expect(git(skills, 'status', '--porcelain')).toContain('?? stray-draft.py');

    // But work in a file the patch itself touches still refuses, by name —
    // that is the case where applying would clobber something.
    git(skills, 'reset', '--hard', before);
    writeFileSync(join(skills, 'demo', 'SKILL.md'), head + 'edited by hand\n');
    writeFileSync(
      join(feedback, 'demo', '2026-06-06-narrow.md'),
      readFileSync(join(feedback, 'demo', '2026-06-06-narrow.md'), 'utf8').replace(
        'status: applied',
        'status: approved',
      ),
    );
    const clash = await api('POST', '/api/apply', { id: 'user/demo/2026-06-06-narrow.md' });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/patch's own files have uncommitted work/);
    expect(clash.body.error).toContain('demo/SKILL.md');

    git(skills, 'checkout', '--', '.');
    rmSync(join(skills, 'stray-draft.py'), { force: true });
    // Off the corpus again: it shares a scope with the cascade fixture below,
    // and a stray sibling would change what that test counts.
    rmSync(join(feedback, 'demo', '2026-06-06-narrow.md'), { force: true });
    rmSync(join(feedback, 'demo', '2026-06-06-narrow.patch'), { force: true });
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

/**
 * The commit that lands a fix closes its scope siblings — the 27-orphans
 * defect, solved mechanically instead of by a doctor report.
 */
describe('apply closes the siblings of its scope', () => {
  it('lands the lead as a commit and supersedes open siblings sharing its scope', async () => {
    const feedback = join(root, 'skills-feedback', 'demo');
    const suggestionFile = (slug, status, scope) =>
      writeFileSync(
        join(feedback, `2026-05-05-${slug}.md`),
        `---\nskill: demo\ndate: 2026-05-05\nseverity: low\ntype: hygiene\nobjective: debt\neffort: S\nrung: 1\nscope: ${scope}\nstatus: ${status}\n---\n\n## Context\n\nc\n\n## Suggestion\n\ns\n\n## Plan\n\np\n\n## Validation\n\nv\n`,
      );
    suggestionFile('lead', 'approved', 'demo/SKILL.md');
    suggestionFile('sib', 'recorded', 'demo/SKILL.md');
    suggestionFile('far', 'recorded', 'other/file.md');
    writeFileSync(
      join(feedback, '2026-05-05-lead.patch'),
      [
        '--- a/demo/SKILL.md',
        '+++ b/demo/SKILL.md',
        '@@ -1,4 +1,5 @@',
        ' ---',
        ' name: demo',
        ' ---',
        ' # demo',
        '+one guardrail line',
        '',
      ].join('\n'),
    );

    const { status, body } = await api('POST', '/api/apply', { id: 'user/demo/2026-05-05-lead.md' });
    expect(status).toBe(200);
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.closed).toBe(1);

    expect(readFileSync(join(feedback, '2026-05-05-lead.md'), 'utf8')).toMatch(/status: applied/);
    const sib = readFileSync(join(feedback, '2026-05-05-sib.md'), 'utf8');
    expect(sib).toMatch(/status: superseded/);
    expect(sib).toContain(`superseded_by: ${body.sha}`);
    expect(readFileSync(join(feedback, '2026-05-05-far.md'), 'utf8')).toMatch(/status: recorded/);

    // The ledger holds the trailer that makes `git log --grep` the index.
    const log = git(join(root, 'skills'), 'log', '-1', '--format=%B');
    expect(log).toContain('Kaizen-Suggestion: user/demo/2026-05-05-lead.md');
  });
});

/**
 * The wide approve: one decision drains everything approvable — what can
 * legally move moves, an unready candidate is skipped and counted, and a
 * corpus with nothing movable refuses rather than pretending.
 */
describe('POST /api/sweep', () => {
  it('moves the movable, counts the unready, and refuses when nothing can move', async () => {
    const file = (slug, status, planned = '\n## Plan\n\np\n\n## Validation\n\nv\n') =>
      writeFileSync(
        join(root, 'skills-feedback', 'demo', `2026-04-04-${slug}.md`),
        `---\nskill: demo\ndate: 2026-04-04\nseverity: low\ntype: hygiene\nobjective: debt\neffort: S\nrung: 1\nstatus: ${status}\n---\n\n## Context\n\nc\n\n## Suggestion\n\ns\n${planned}`,
      );
    file('sweep-a', 'planned');
    file('sweep-b', 'planned');
    writeFileSync(join(root, 'skills-feedback', 'demo', '2026-04-04-sweep-a.patch'), 'x\n');

    // Only the planned move; the applied fixture from the tests above is not a
    // candidate and must not be counted as "skipped" noise.
    const { status, body } = await api('POST', '/api/sweep', { status: 'approved' });
    expect(status).toBe(200);
    expect(body.moved).toBe(2);
    expect(body.skipped).toBe(0);
    expect(readFileSync(join(root, 'skills-feedback', 'demo', '2026-04-04-sweep-a.md'), 'utf8')).toMatch(
      /status: approved/,
    );

    // Everything approvable was just approved, so a second sweep has nothing.
    const again = await api('POST', '/api/sweep', { status: 'approved' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/nothing can become/);
  });
});

/**
 * Dispatch hands the backlog to one detached claude run. The tests cover the
 * seat, not the agent: one run at a time, and the seat frees when it exits.
 */
describe('POST /api/dispatch', () => {
  it('starts one run, refuses a second while it lives, and frees the seat on exit', async () => {
    // A fully-triaged-but-unplanned backlog must open the seat — gating on the
    // untriaged count alone once refused exactly this file.
    writeFileSync(
      join(root, 'skills-feedback', 'demo', '2026-03-03-still-unplanned.md'),
      '---\nskill: demo\ndate: 2026-03-03\nseverity: low\ntype: hygiene\nobjective: debt\neffort: S\nrung: 1\nstatus: triaged\n---\n\n## Context\n\nc\n\n## Suggestion\n\ns\n',
    );
    const first = await api('POST', '/api/dispatch');
    expect(first.status).toBe(200);
    expect(first.body.pid).toBe(spawned.at(-1).pid);
    expect(first.body.pending).toBeGreaterThan(0);

    // State carries the run while it lives — this is what the TUI's chip and
    // agents tab draw. A backlog run has no fence, so `id` is null.
    const during = await api('GET', '/api/state');
    expect(during.body.dispatch).toEqual({
      runs: [{ running: true, pid: first.body.pid, exitCode: null, id: null, startedAt: expect.any(Number) }],
      queue: [],
    });

    const second = await api('POST', '/api/dispatch');
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already in flight/);

    spawned.at(-1).emit('exit', 1, null);
    const after = await api('GET', '/api/state');
    expect(after.body.dispatch.runs).toEqual([
      { running: false, pid: first.body.pid, exitCode: 1, id: null, startedAt: expect.any(Number) },
    ]);

    const third = await api('POST', '/api/dispatch');
    expect(third.status).toBe(200);
    expect(third.body.pid).not.toBe(first.body.pid);
    spawned.at(-1).emit('exit', 0, null);
  });

  it('fences a run to one suggestion when given an id, and gates on what a pass can move', async () => {
    const id = 'user/demo/2026-03-03-still-unplanned.md';
    const { status, body } = await api('POST', '/api/dispatch', { id });
    expect(status).toBe(200);
    expect(body.pending).toBe(1);
    expect(spawned.at(-1).fencedTo).toBe(id);
    // The fence rides on state too — the agents tab names what the run is on.
    const during = await api('GET', '/api/state');
    expect(during.body.dispatch.runs.at(-1)).toMatchObject({ id, running: true });
    spawned.at(-1).emit('exit', 0, null);

    const missing = await api('POST', '/api/dispatch', { id: 'user/demo/2026-01-01-nope.md' });
    expect(missing.status).toBe(404);

    // The first fixture has been applied by the tests above — a pass owes it
    // nothing, and the refusal names its status rather than shrugging.
    const done = await api('POST', '/api/dispatch', { id: 'user/demo/2026-01-01-a-thing.md' });
    expect(done.status).toBe(422);
    expect(done.body.error).toMatch(/nothing for a pass/);
  });

  /**
   * The gate reads `blocked_on` because the alternative is paying an agent to
   * rediscover it. A parked card looks pending by status, so every press of `a`
   * on one — and every reseat of a backlog run — spent a detached model call
   * whose only possible outcome was re-stamping `confirmed_at`. Ten members of
   * one scope carried by a single patch is ten runs for nothing.
   */
  it('refuses a pass fenced to a parked card and does not count it as backlog work', async () => {
    const alone = mkdtempSync(join(tmpdir(), 'kaizen-parked-'));
    const skills = join(alone, 'skills');
    const feedback = join(alone, 'skills-feedback');
    mkdirSync(join(skills, 'demo'), { recursive: true });
    mkdirSync(join(feedback, 'demo'), { recursive: true });
    writeFileSync(join(skills, 'demo', 'SKILL.md'), '---\nname: demo\n---\n# demo\n');
    writeFileSync(
      join(feedback, 'demo', '2026-03-06-parked.md'),
      '---\nskill: demo\ndate: 2026-03-06\nseverity: low\nstatus: triaged\nblocked_on: carried by the scope patch — supersede once it lands\n---\n\n## Context\n\nc\n\n## Suggestion\n\ns\n',
    );
    const mine = [];
    const only = createApp(
      { ...config, targets: [{ name: 'user', skills, feedback, writable: true }] },
      {
        spawnClaude: (id) => {
          const child = new EventEmitter();
          child.pid = 9900 + mine.length;
          mine.push(id);
          process.nextTick(() => child.emit('spawn'));
          return child;
        },
      },
    );
    await new Promise((r) => only.listen(0, '127.0.0.1', r));
    const call = async (body) => {
      const res = await fetch(`http://127.0.0.1:${only.address().port}/api/dispatch`, {
        method: 'POST',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    };

    // Fenced: refused, and the refusal is the card's own words — which is what
    // tells you the block is real rather than the button being broken.
    const fenced = await call({ id: 'user/demo/2026-03-06-parked.md' });
    expect(fenced.status).toBe(422);
    expect(fenced.body.error).toMatch(/is parked: carried by the scope patch/);

    // The backlog: `triaged` is pending by status, so the only thing that can
    // make this corpus read as empty is the block being counted.
    const backlog = await call();
    expect(backlog.status).toBe(422);
    expect(backlog.body.error).toMatch(/nothing for a pass to do/);

    expect(mine).toEqual([]);
    await new Promise((r) => only.close(r));
    rmSync(alone, { recursive: true, force: true });
  });

  it('queues behind a live run, one entry per card, and hands the seat on when it exits', async () => {
    const a = 'user/demo/2026-03-03-still-unplanned.md';
    const b = 'user/demo/2026-03-04-also-waiting.md';
    writeFileSync(
      join(root, 'skills-feedback', 'demo', '2026-03-04-also-waiting.md'),
      '---\nskill: demo\ndate: 2026-03-04\nseverity: low\nstatus: recorded\n---\n\n## Context\n\nc\n\n## Suggestion\n\ns\n',
    );
    const first = await api('POST', '/api/dispatch', { id: a });
    expect(first.status).toBe(200);
    const running = spawned.at(-1);

    // `a` on a second card while the seat is taken is a place in line, not a
    // 409 — that was five presses, one run and four errors.
    const queued = await api('POST', '/api/dispatch', { id: b });
    expect(queued.status).toBe(200);
    expect(queued.body).toEqual({ pending: 1, queued: 1 });
    // Pressing it again does not stack a second run behind the first.
    expect((await api('POST', '/api/dispatch', { id: b })).body.queued).toBe(1);
    // The backlog can wait its turn too, once.
    expect((await api('POST', '/api/dispatch')).body.queued).toBe(2);
    expect((await api('POST', '/api/dispatch')).body.queued).toBe(2);
    // The card already in the seat is the one thing that still refuses.
    const twice = await api('POST', '/api/dispatch', { id: a });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toMatch(/already in flight/);

    // The line rides on state, in order, so the board can number the cards.
    const during = await api('GET', '/api/state');
    expect(during.body.dispatch.queue).toEqual([b, null]);
    expect(spawned.at(-1)).toBe(running);

    // The seat frees: the next in line takes it without anyone asking.
    running.emit('exit', 0, null);
    await new Promise((r) => setImmediate(r));
    expect(spawned.at(-1)).not.toBe(running);
    expect(spawned.at(-1).fencedTo).toBe(b);
    const next = await api('GET', '/api/state');
    expect(next.body.dispatch.runs.at(-1)).toMatchObject({ id: b, running: true });
    expect(next.body.dispatch.queue).toEqual([null]);

    // Then the backlog's turn.
    spawned.at(-1).emit('exit', 0, null);
    await new Promise((r) => setImmediate(r));
    const backlog = spawned.at(-1);
    expect(backlog.fencedTo).toBeNull();

    // A queued card that was moved meanwhile is skipped, not run: the gate is
    // re-checked when its turn comes, and a seat nobody needs stays empty.
    const c = 'user/demo/2026-03-05-moved-meanwhile.md';
    writeFileSync(
      join(root, 'skills-feedback', 'demo', '2026-03-05-moved-meanwhile.md'),
      '---\nskill: demo\ndate: 2026-03-05\nseverity: low\nstatus: recorded\n---\n\n## Context\n\nc\n\n## Suggestion\n\ns\n',
    );
    expect((await api('POST', '/api/dispatch', { id: c })).body.queued).toBe(1);
    const moved = await api('POST', '/api/suggestion', { id: c, status: 'rejected' });
    expect(moved.status).toBe(200);
    backlog.emit('exit', 0, null);
    await new Promise((r) => setImmediate(r));
    expect(spawned.at(-1)).toBe(backlog);
    const drained = await api('GET', '/api/state');
    expect(drained.body.dispatch.queue).toEqual([]);
    expect(drained.body.dispatch.runs.every((r) => !r.running)).toBe(true);
  });

  it('runs fenced cards in parallel up to dispatch.maxAgents, and a backlog run alone', async () => {
    const mine = [];
    const spawner = (id) => {
      const child = new EventEmitter();
      child.pid = 9200 + mine.length;
      child.fencedTo = id;
      mine.push(child);
      process.nextTick(() => child.emit('spawn'));
      return child;
    };
    const two = createApp({ ...config, dispatch: { auto: false, maxAgents: 2 } }, { spawnClaude: spawner });
    await new Promise((r) => two.listen(0, '127.0.0.1', r));
    const call = async (method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${two.address().port}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    };
    const a = 'user/demo/2026-03-03-still-unplanned.md';
    const b = 'user/demo/2026-03-04-also-waiting.md';
    const c = 'user/demo/2026-03-05-third-card.md';
    writeFileSync(
      join(root, 'skills-feedback', 'demo', '2026-03-05-third-card.md'),
      '---\nskill: demo\ndate: 2026-03-05\nseverity: low\nstatus: recorded\n---\n\n## Context\n\nc\n\n## Suggestion\n\ns\n',
    );
    // Two seats: two fenced runs go at once, the third waits.
    expect((await call('POST', '/api/dispatch', { id: a })).body.pid).toBe(9200);
    expect((await call('POST', '/api/dispatch', { id: b })).body.pid).toBe(9201);
    expect((await call('POST', '/api/dispatch', { id: c })).body).toEqual({ pending: 1, queued: 1 });
    // A backlog request behind them queues too: it needs every seat.
    expect((await call('POST', '/api/dispatch')).body.queued).toBe(2);
    let state = (await call('GET', '/api/state')).body.dispatch;
    expect(state.runs.filter((r) => r.running).map((r) => r.id)).toEqual([a, b]);
    expect(state.queue).toEqual([c, null]);

    // One seat frees: the head of the line takes it; the backlog still waits.
    mine[0].emit('exit', 0, null);
    await new Promise((r) => setImmediate(r));
    expect(mine.at(-1).fencedTo).toBe(c);
    state = (await call('GET', '/api/state')).body.dispatch;
    expect(state.runs.filter((r) => r.running).map((r) => r.id)).toEqual([b, c]);
    expect(state.queue).toEqual([null]);

    // Both seats free: the backlog runs, alone — and nothing fenced starts
    // behind it until it is done.
    mine[1].emit('exit', 0, null);
    mine[2].emit('exit', 0, null);
    await new Promise((r) => setImmediate(r));
    expect(mine.at(-1).fencedTo).toBeNull();
    expect((await call('POST', '/api/dispatch', { id: a })).body.queued).toBe(1);
    mine.at(-1).emit('exit', 0, null);
    await new Promise((r) => setImmediate(r));
    expect(mine.at(-1).fencedTo).toBe(a);
    mine.at(-1).emit('exit', 0, null);
    await new Promise((r) => two.close(r));
    writeFileSync(join(root, 'kaizen', 'dispatch.json'), JSON.stringify({ runs: [], queue: [] }));
  });

  it('keeps the seat and the line on disk, and a fresh server picks them back up', async () => {
    const b = 'user/demo/2026-03-04-also-waiting.md';
    const file = join(root, 'kaizen', 'dispatch.json');
    // The tests above left the seats free and the line empty — and said so on disk.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ runs: [], queue: [] });

    // A dead pid with a line behind it: the seat is free, so the line resumes
    // at once — the first entry a pass can still move gets a run.
    writeFileSync(file, JSON.stringify({ runs: [{ pid: 2 ** 22 - 1, id: null, startedAt: 1 }], queue: [b] }));
    const mine = [];
    const spawner = (id) => {
      const child = new EventEmitter();
      child.pid = 9000 + mine.length;
      child.fencedTo = id;
      mine.push(child);
      process.nextTick(() => child.emit('spawn'));
      return child;
    };
    const app2 = createApp(config, { spawnClaude: spawner });
    await new Promise((r) => app2.listen(0, '127.0.0.1', r));
    await new Promise((r) => setImmediate(r));
    expect(mine.map((c) => c.fencedTo)).toEqual([b]);
    const res = await fetch(`http://127.0.0.1:${app2.address().port}/api/state`);
    const d2 = (await res.json()).dispatch;
    expect(d2.runs.at(-1)).toMatchObject({ running: true, id: b });
    expect(d2.queue).toEqual([]);
    mine[0].emit('exit', 0, null);
    await new Promise((r) => app2.close(r));

    // A pid still alive is adopted as the run in the seat: not respawned, and
    // its line waits behind it.
    writeFileSync(file, JSON.stringify({ runs: [{ pid: process.pid, id: b, startedAt: 5 }], queue: [null] }));
    const app3 = createApp(config, { spawnClaude: spawner });
    await new Promise((r) => app3.listen(0, '127.0.0.1', r));
    await new Promise((r) => setImmediate(r));
    expect(mine.length).toBe(1);
    const res3 = await fetch(`http://127.0.0.1:${app3.address().port}/api/state`);
    const d3 = (await res3.json()).dispatch;
    expect(d3.runs.at(-1)).toMatchObject({ running: true, pid: process.pid, id: b });
    expect(d3.queue).toEqual([null]);
    await new Promise((r) => app3.close(r));
    writeFileSync(file, JSON.stringify({ runs: [], queue: [] }));
  });

  it('with dispatch.auto on, a new arrival is a run without a key, and a parked card is not a loop', async () => {
    const mine = [];
    const spawner = (id) => {
      const child = new EventEmitter();
      child.pid = 9100 + mine.length;
      child.fencedTo = id;
      mine.push(child);
      process.nextTick(() => child.emit('spawn'));
      return child;
    };
    const auto = createApp({ ...config, dispatch: { auto: true, maxAgents: 1 } }, { spawnClaude: spawner });
    await new Promise((r) => auto.listen(0, '127.0.0.1', r));
    await new Promise((r) => setImmediate(r));
    // On start, what waits is new: one backlog run.
    expect(mine.map((c) => c.fencedTo)).toEqual([null]);

    // The run ends having moved nothing (the fake never writes): the same
    // cards still wait, but they are not newcomers — no second run.
    mine[0].emit('exit', 0, null);
    await new Promise((r) => setImmediate(r));
    expect(mine.length).toBe(1);

    // A new file lands: the watcher sees it, and that is a run.
    writeFileSync(
      join(root, 'skills-feedback', 'demo', '2026-03-06-brand-new.md'),
      '---\nskill: demo\ndate: 2026-03-06\nseverity: low\nstatus: recorded\n---\n\n## Context\n\nc\n\n## Suggestion\n\ns\n',
    );
    await new Promise((r) => setTimeout(r, 700));
    expect(mine.length).toBe(2);
    expect(mine[1].fencedTo).toBe(null);
    mine[1].emit('exit', 0, null);
    await new Promise((r) => auto.close(r));
  });

  it('serves the dispatch log tail, and an empty log is not an error', async () => {
    // No runs yet is a fact, not an error — the fake spawner writes no log.
    const empty = await api('GET', '/api/dispatch/log');
    expect(empty.status).toBe(200);
    expect(empty.body.text).toBe('');

    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    writeFileSync(join(root, 'kaizen', 'dispatch.log'), lines);
    const { status, body } = await api('GET', '/api/dispatch/log');
    expect(status).toBe(200);
    expect(body.text.endsWith('line 300\n')).toBe(true);
    expect(body.text).not.toContain('line 99\n');
    expect(body.text.split('\n').length).toBeLessThanOrEqual(201);
  });
});

/**
 * The pidfile is what turns "port in use" into a diagnosis. No auto-kill —
 * these assert the three sentences, not a replacement policy.
 */
describe('pidfile', () => {
  it('writes a pidfile on listen, removes it on close, and names a live holder', async () => {
    const { startServer, describePortHolder } = await import('@kaizen/server');
    const dir = mkdtempSync(join(tmpdir(), 'kaizen-pid-'));
    const pidfile = join(dir, 'server.pid');
    const port = 17000 + Math.floor(Math.random() * 1000);
    const srv = await startServer({ ...config, server: { host: '127.0.0.1', port } }, { pidfile });
    try {
      expect(Number(readFileSync(pidfile, 'utf8').trim())).toBe(process.pid);
      expect(describePortHolder(port, pidfile)).toMatch(/already running \(pid \d+, heartbeat \ds ago\)/);
    } finally {
      await new Promise((r) => srv.close(r));
    }
    expect(() => readFileSync(pidfile)).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('tells a dead holder from a missing pidfile', async () => {
    const { describePortHolder } = await import('@kaizen/server');
    const dir = mkdtempSync(join(tmpdir(), 'kaizen-pid-'));
    const pidfile = join(dir, 'server.pid');
    expect(describePortHolder(7777, pidfile)).toContain('no pidfile to confirm');
    writeFileSync(pidfile, '999999999\n'); // beyond pid_max: guaranteed dead
    expect(describePortHolder(7777, pidfile)).toContain('is gone');
    rmSync(dir, { recursive: true, force: true });
  });
});

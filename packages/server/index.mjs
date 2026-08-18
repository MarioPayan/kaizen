/**
 * The local API.
 *
 * A small route table, `node:http`, bound to loopback. Every route is a file
 * read, a file write, or a git call — save one, which starts a detached claude
 * run — there is no layer here worth a framework.
 *
 * Two things are not negotiable and are enforced rather than documented:
 *   - the socket binds 127.0.0.1, because these routes write files and shell out
 *     to git, and that binding is the entire security boundary
 *   - every caller-supplied path is resolved and asserted inside a configured
 *     target before it is touched
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  utimesSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  readSync,
} from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildState,
  configPath,
  resolveTargets,
  saveConfig,
  validateConfig,
  withDefaults,
  loadConfig,
  assertInside,
  parseSuggestionId,
  writeFrontmatter,
  parseFrontmatter,
  canonicalStatus,
  canTransition,
  pendingPass,
  nextStatuses,
  statusIds,
  missingRequirements,
  requirementsFor,
} from '@kaizen/core';
import { createEventStream } from './events.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    // Per-field messages, when the failure has them. The Settings form reads
    // these; everything else reads `message`.
    this.fields = fields;
  }
}

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The page never loads anything remote; say so rather than relying on it.
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
  });
  res.end(payload);
};

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

/* ------------------------------------------------------------- helpers ---- */

/** Resolve a suggestion id to a file, refusing anything outside a target. */
function suggestionFile(config, id) {
  let parsed;
  try {
    parsed = parseSuggestionId(id);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  const { target, skill, file } = parsed;
  const t = resolveTargets(config).find((x) => x.name === target);
  if (!t) throw new HttpError(404, `unknown target "${target}"`);
  if (!t.feedback) throw new HttpError(404, `target "${target}" is discovery-only — it holds no suggestions`);
  const candidate = join(t.feedback, skill, file);
  try {
    assertInside([t.feedback], candidate, 'suggestion');
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  if (!existsSync(candidate)) throw new HttpError(404, `no such suggestion: ${id}`);
  return { path: candidate, target: t };
}

/* ------------------------------------------------------------ transitions -- */

/**
 * `applied` is a statement that git returned a commit sha. Only the code that
 * saw the sha may write it, or the queue can claim work landed that did not.
 */
const SERVER_OWNED = new Set(['applied']);

/** What a suggestion is at right now, canonically. One file read, no full scan. */
function currentStatus(config, id) {
  const { path } = suggestionFile(config, id);
  const { data } = parseFrontmatter(readFileSync(path, 'utf8'));
  return canonicalStatus(data.status) ?? 'recorded';
}

/** A status a caller is allowed to name at all. Aliases resolve, so `new` works. */
function assertSettable(status) {
  const to = canonicalStatus(status);
  if (!to) throw new HttpError(400, `status must be one of ${statusIds().join(', ')}`);
  if (SERVER_OWNED.has(to)) throw new HttpError(403, `"${to}" is set by the server, not by hand`);
  return to;
}

/**
 * The move has to be one the model allows.
 *
 * This is the whole reason the transitions are data. `approved` is reachable
 * only from `planned`, and `planned` is unreachable without a patch and a
 * validation plan — so the state that produced a 39-item queue of approvals
 * with nothing behind them cannot be written any more. The refusal names where
 * the suggestion actually is and where it may legally go, because a bare 409
 * on a button press is indistinguishable from a bug.
 */
function assertTransition(from, to, id) {
  if (canTransition(from, to)) return;
  const onward = nextStatuses(from);
  throw new HttpError(
    409,
    `${id.split('/').at(-1)} is "${from}" — it cannot become "${to}". ` +
      (onward.length
        ? `From "${from}" it can only become: ${onward.join(', ')}.`
        : `"${from}" is terminal; nothing follows it.`),
  );
}

/**
 * The other half of the gate, and the half that was missing.
 *
 * Checking only the transition graph left the model bypassable in three hops:
 * `recorded → triaged → planned → approved` reached an approval with no patch
 * and no validation plan, which is precisely the state the whole spec exists to
 * prevent. A phase declares what it produces; you may not leave it until it has.
 */
function assertRequirements(config, id, to) {
  const { path } = suggestionFile(config, id);
  const { data, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  const missing = missingRequirements(to, {
    data,
    body,
    hasPatch: existsSync(path.replace(/\.md$/, '.patch')),
  });
  if (missing.length === 0) return;
  const how = requirementsFor(to)
    .filter((f) => missing.includes(f.id))
    .map((f) =>
      f.where === 'body'
        ? `${f.id} (a "## ${f.heading}" section)`
        : f.where === 'sibling'
          ? `${f.id} (a sibling ${f.suffix} file)`
          : `${f.id}`,
    );
  throw new HttpError(
    409,
    `${id.split('/').at(-1)} cannot become "${to}" yet — that phase requires ${how.join(', ')}.`,
  );
}

async function git(cwd, args) {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    throw new HttpError(422, e.stderr?.trim() || e.message);
  }
}

/**
 * `git revert` commits by itself and touches whatever the reverted commit did,
 * so it is the one operation that still wants the whole tree clean. Refuse, and
 * name the files.
 */
async function assertCleanTree(cwd) {
  const status = await git(cwd, ['status', '--porcelain']);
  if (status.trim()) {
    const files = status
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => l.slice(3))
      .join(', ');
    throw new HttpError(409, `working tree is not clean — commit or stash first: ${files}`);
  }
}

/**
 * What actually has to be clean for a patch to land as one honest commit.
 *
 * Not the whole tree. The apply stages the patch's own paths and nothing else
 * (`git apply --index`), so an untracked draft or an edit somewhere unrelated
 * cannot end up in a kaizen commit — and refusing over one stops a queue for a
 * reason that is not true. An untracked Python file two directories away held
 * up eleven cards that way.
 *
 * Two things would still break the commit, so both refuse and name the files:
 * a path the patch touches carrying uncommitted work (the apply would clobber
 * it, and `git revert` would stop being a clean undo), and anything already
 * staged (the commit would carry it along). `git apply --index` is the backstop
 * for the first — it refuses rather than clobbers — so this check exists to say
 * which file, in words, before git says it in its own.
 */
async function assertApplyable(cwd, patch) {
  const staged = await git(cwd, ['diff', '--cached', '--name-only']);
  if (staged.trim()) {
    throw new HttpError(
      409,
      `something is already staged — commit or reset it first: ${staged.trim().split('\n').join(', ')}`,
    );
  }
  // The paths the patch itself names. `--numstat` prints `added deleted path`,
  // so the path is what survives the last tab. A patch git cannot even read is
  // one whose reach is unknown, so that falls back to the blunt whole-tree
  // check rather than to no check at all.
  let touched;
  try {
    touched = (await git(cwd, ['apply', '--numstat', patch]))
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => l.split('\t').at(-1));
  } catch {
    return assertCleanTree(cwd);
  }
  if (!touched.length) return;

  const status = await git(cwd, ['status', '--porcelain', '--', ...touched]);
  if (status.trim()) {
    // Split the raw output, not a trimmed copy. Porcelain lines are `XY PATH`
    // with a two-column status, so an unstaged change starts with a space —
    // trimming first ate that space on the first line only, and slice(3) then
    // took a character off the filename. The one this refusal exists to name.
    const files = status
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => l.slice(3))
      .join(', ');
    throw new HttpError(409, `the patch's own files have uncommitted work — commit or stash first: ${files}`);
  }
}

/* -------------------------------------------------------------- routes ---- */

const routes = {
  'GET /api/health': async (_req, _res, ctx) => ({
    ok: true,
    version: ctx.version,
    targets: ctx.config.targets.length,
  }),

  // `dispatch` rides on state rather than its own route: the TUI draws from
  // state and refreshes on events, so a separate poll would be a second clock.
  'GET /api/state': async (_req, _res, ctx) => ({
    ...buildState(ctx.config),
    // Every run this server has seen, oldest first and capped, each saying
    // whether it is still going; then who waits for a seat, in order (`null`
    // is the backlog). The board spins the running ones and numbers the line.
    dispatch: {
      runs: ctx.runs.map((r) => ({
        pid: r.pid,
        id: r.triageId,
        running: !r.done,
        exitCode: r.done ? (r.done.code ?? -1) : null,
        // Epoch ms, not ISO like `generatedAt`: the TUI renders "up 3m" and
        // one subtraction beats a date parser it would otherwise not have.
        startedAt: r.startedAt,
      })),
      queue: ctx.queue,
    },
  }),

  'GET /api/config': async (_req, _res, ctx) => ({ config: ctx.config, errors: validateConfig(ctx.config) }),

  'POST /api/config': async (req, _res, ctx) => {
    const next = await readBody(req);
    const errors = validateConfig(next);
    // The array, not a joined string: the form puts each message under the field
    // its config path names, and re-splitting prose to get there is worse.
    if (errors.length) throw new HttpError(400, `invalid config: ${errors.join('; ')}`, errors);
    saveConfig(next);
    ctx.config = withDefaults(next);
    // The target list may have changed, and with it what is worth watching.
    ctx.events?.restart();
    // Flipping auto on is the ask: send fable at what is waiting, now.
    if (ctx.config.dispatch?.auto) {
      ctx.events?.watch();
      maybeAutoDispatch(ctx);
    }
    return { config: next };
  },

  // Rendering a skill means reading its markdown from wherever it actually lives.
  // Nothing is copied into kaizen, so this is always the current file on disk.
  'GET /api/skill': async (req, _res, ctx) => {
    const path = new URL(req.url, 'http://localhost').searchParams.get('path');
    if (!path) throw new HttpError(400, 'path is required');
    const roots = resolveTargets(ctx.config)
      .flatMap((t) => [t.skills, t.feedback])
      .filter(Boolean);
    let file;
    try {
      file = assertInside(roots, path, 'skill');
    } catch (e) {
      throw new HttpError(403, e.message);
    }
    const info = await stat(file);
    if (info.size > 2_000_000) throw new HttpError(413, 'file too large to render');
    return { path: file, content: await readFile(file, 'utf8') };
  },

  'GET /api/diff': async (req, _res, ctx) => {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id');
    if (!id) throw new HttpError(400, 'id is required');
    const { path } = suggestionFile(ctx.config, id);
    const patch = path.replace(/\.md$/, '.patch');
    if (!existsSync(patch)) return { id, patch: null };
    return { id, patch: await readFile(patch, 'utf8') };
  },

  // Status changes are the approval gate. They are recorded, never acted on here.
  'POST /api/suggestion': async (req, _res, ctx) => {
    const { id, status, notes } = await readBody(req);
    const to = assertSettable(status);
    const { path } = suggestionFile(ctx.config, id);
    const from = currentStatus(ctx.config, id);
    // Setting a status to what it already is is a double-click, not an illegal
    // move. Notes still land, so a re-decision can add its reason.
    if (from !== to) {
      assertTransition(from, to, id);
      assertRequirements(ctx.config, id, to);
    }
    writeFrontmatter(path, notes ? { status: to, notes } : { status: to });
    return { id, status: to };
  },

  /**
   * Approving a category is one decision, so applying one is one call.
   *
   * Every member is checked before any member is written. A category where one
   * suggestion is further along than the rest would otherwise be half-moved,
   * and there is no transaction to roll back a partial write of eleven files.
   */
  // One decision can drain the whole pile: move everything that can legally
  // make the move and meets the phase's requirements, skip the rest, and say
  // how many of each. `skipped` counts only true candidates — items whose
  // transition is legal but whose requirements are missing — not the corpus's
  // history, which would drown the number that matters.
  'POST /api/sweep': async (req, _res, ctx) => {
    const { status } = await readBody(req);
    const to = assertSettable(status);
    const state = buildState(ctx.config);
    const candidates = state.suggestions.filter((s) => canTransition(s.status, to));

    const moved = [];
    for (const s of candidates) {
      try {
        assertRequirements(ctx.config, s.id, to);
      } catch {
        continue;
      }
      const { path } = suggestionFile(ctx.config, s.id);
      writeFrontmatter(path, { status: to });
      moved.push(s.id);
    }
    if (!moved.length) throw new HttpError(409, `nothing can become ${to}`);
    return { status: to, moved: moved.length, skipped: candidates.length - moved.length };
  },

  // Triage is unattended by design, so the TUI can start it without leaving the
  // terminal. The server only launches and remembers the child — progress
  // arrives like any other edit, through the file watcher, so the queue's rows
  // relabel themselves as the run writes frontmatter.
  'POST /api/dispatch': async (req, _res, ctx) => {
    // `null` is the backlog, on the wire and in the queue alike.
    const { id = null } = await readBody(req);
    const pending = passPending(ctx, id);
    // The same work twice is the one thing that still refuses: the card (or
    // the backlog) already has an agent on it.
    const dup = live(ctx).find((r) => r.triageId === id);
    if (dup) {
      throw new HttpError(
        409,
        `${id ? id.split('/').at(-1) : 'the backlog'} is already in flight (pid ${dup.pid})`,
      );
    }
    if (canSeat(ctx, id) && !ctx.queue.length) {
      const child = await launch(ctx, id);
      return { pid: child.pid, pending };
    }
    // No seat, or a line already ahead: take a place rather than refuse, so
    // `a` on five cards is five runs, not one run and four errors. One entry
    // per id (and one for the backlog) — a held key must not stack twenty.
    let at = ctx.queue.indexOf(id);
    if (at < 0) {
      at = ctx.queue.push(id) - 1;
      persistDispatch(ctx);
      ctx.events.broadcast('dispatch', { queued: ctx.queue.length });
    }
    return { pending, queued: at + 1 };
  },

  // The tail only, bounded twice (bytes then lines): the log is append-only
  // and never rotated, and the TUI wants the latest runs, not the archive.
  // The path is entirely server-derived — no caller input, so there is
  // nothing here for `assertInside` to check.
  'GET /api/dispatch/log': async () => {
    const log = join(dirname(configPath()), 'dispatch.log');
    if (!existsSync(log)) return { text: '' };
    const size = statSync(log).size;
    const fd = openSync(log, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, 65536));
      readSync(fd, buf, 0, buf.length, size - buf.length);
      let text = buf.toString('utf8');
      // A byte-offset read can open mid-line (and mid-codepoint); drop the
      // partial first line rather than showing garbage.
      if (buf.length < size) text = text.slice(text.indexOf('\n') + 1);
      return { text: text.split('\n').slice(-201).join('\n') };
    } finally {
      closeSync(fd);
    }
  },

  'POST /api/apply': async (req, _res, ctx) => {
    const { id } = await readBody(req);
    const { path, target } = suggestionFile(ctx.config, id);
    if (!target.writable) throw new HttpError(403, `target "${target.name}" is read-only`);
    // Apply and commit at the repo root that owns the skills dir, not the dir
    // itself — a target whose skills sit inside a larger repo (kaizen's own
    // skills/ folder) carries patches rooted at that repo.
    const root = (await git(target.skills, ['rev-parse', '--show-toplevel'])).trim();
    // The same gate as any other move. Applying is the one transition the server
    // performs on its own, which is exactly why it should not be the one that
    // skips the check.
    assertTransition(currentStatus(ctx.config, id), 'applied', id);
    // No requirements check here. `requires` lists what a phase *produces*, and
    // the apply phase produces `applied_sha` — which this handler writes a few
    // lines below, once git has returned one. Demanding it up front is a gate
    // that can never open. The patch check further down is the real precondition.

    const patch = path.replace(/\.md$/, '.patch');
    if (!existsSync(patch)) throw new HttpError(422, 'no proposal patch for this suggestion yet');

    if (ctx.config.applyGuards?.requireCleanTree !== false) await assertApplyable(root, patch);
    if (ctx.config.applyGuards?.requireDiffApplies !== false) {
      await git(root, ['apply', '--check', patch]);
    }

    // `--index` rather than apply-then-`add -A`: it stages exactly the paths the
    // patch names, so the commit cannot pick up work that was merely sitting in
    // the tree, and it refuses outright rather than clobbering a path someone
    // else has edited. That is what lets the guard above be narrow.
    await git(root, ['apply', '--index', patch]);
    await git(root, [
      'commit',
      '-m',
      `kaizen: ${id.split('/').at(-1).replace(/\.md$/, '')}`,
      '-m',
      `Kaizen-Suggestion: ${id}`,
    ]);
    const sha = (await git(root, ['rev-parse', 'HEAD'])).trim();
    writeFrontmatter(path, { status: 'applied', applied_sha: sha });

    // One scope is one fix, so the commit that lands it closes the siblings.
    // This is what the 27 orphans were: the drain marked only the suggestion
    // named in its trailer, and everything else sharing the scope rotted as
    // open work. Mechanical now, with the sha recorded so the trail survives.
    const { data: appliedData } = parseFrontmatter(readFileSync(path, 'utf8'));
    let closed = 0;
    if (appliedData.scope) {
      for (const s of buildState(ctx.config).suggestions) {
        if (s.id === id || s.scope !== appliedData.scope) continue;
        if (!canTransition(s.status, 'superseded')) continue;
        writeFrontmatter(suggestionFile(ctx.config, s.id).path, {
          status: 'superseded',
          superseded_by: sha,
        });
        closed++;
      }
    }
    return { id, sha, closed };
  },

  'POST /api/revert': async (req, _res, ctx) => {
    const { sha, target: targetName } = await readBody(req);
    if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) throw new HttpError(400, 'sha is not a commit hash');
    const t = resolveTargets(ctx.config).find((x) => x.name === targetName);
    if (!t) throw new HttpError(404, `unknown target "${targetName}"`);
    if (!t.writable) throw new HttpError(403, `target "${t.name}" is read-only`);
    const root = (await git(t.skills, ['rev-parse', '--show-toplevel'])).trim();
    await assertCleanTree(root);
    await git(root, ['revert', '--no-edit', sha]);
    return { reverted: sha };
  },
};

/* ------------------------------------------------------------ dispatch ---- */

/**
 * The gate: what a pass could move if it ran now. With an id the pass is fenced
 * to one suggestion — the skill accepts it as an argument. Without one it takes
 * the backlog. Either way the gate is `pendingPass`, not the untriaged count:
 * the pass also plans the triaged and re-plans the failed, and gating on triage
 * alone refused exactly those — while a parked card looks pending by status and
 * has nothing for a run to do.
 */
function passPending(ctx, id) {
  const state = buildState(ctx.config);
  if (id) {
    const s = state.suggestions.find((x) => x.id === id);
    if (!s) throw new HttpError(404, `no such suggestion: ${id}`);
    if (!pendingPass(s)) {
      // Two different refusals, because they need two different answers: a
      // decided card is finished with passes, a parked one is waiting on the
      // thing its own frontmatter names.
      const why = s.blockedOn ? `is parked: ${s.blockedOn}` : `is "${s.status}" — nothing for a pass to do`;
      throw new HttpError(422, `${id.split('/').at(-1)} ${why}`);
    }
    return 1;
  }
  const pending = state.suggestions.filter((s) => pendingPass(s)).length;
  if (!pending) throw new HttpError(422, 'nothing for a pass to do — all work is decided or yours');
  return pending;
}

/** The runs still going. */
function live(ctx) {
  return ctx.runs.filter((r) => !r.done);
}

/**
 * Is there a seat for this run right now? `dispatch.maxAgents` seats, but a
 * backlog run takes them all: it walks every card, so it cannot share the
 * corpus with a fenced run without two agents writing one file.
 */
function canSeat(ctx, id) {
  const running = live(ctx);
  if (running.some((r) => r.triageId === null)) return false;
  if (id === null) return running.length === 0;
  return running.length < (ctx.config.dispatch?.maxAgents ?? 1);
}

/** Take a seat with one run, and hand it on when the run ends. */
async function launch(ctx, id) {
  const child = ctx.spawnClaude(id);
  await new Promise((launched, failed) => {
    child.once('spawn', launched);
    child.once('error', (e) => failed(new HttpError(500, `could not start claude — ${e.message}`)));
  });
  // `done` rather than `exitCode`: a signal death leaves exitCode null, which
  // reads as still-running and would wedge the seat forever. The broadcast is
  // what tells the TUI the run ended even when it wrote no files.
  child.once('exit', (code, signal) => seatFreed(ctx, child, { code, signal }));
  // What the run is on and since when, so the agents tab can say more than
  // "a pid exists". Recorded here, not in the spawner — tests stub that.
  child.startedAt = Date.now();
  child.triageId = id;
  remember(ctx, child);
  persistDispatch(ctx);
  ctx.events.broadcast('dispatch', { pid: child.pid, running: true });
  return child;
}

/** Keep the run on the list the state reports, and the list bounded. */
const RUNS_KEPT = 20;
function remember(ctx, run) {
  ctx.runs.push(run);
  // Drop the oldest *finished* ones first; a live run is never forgotten.
  while (ctx.runs.length > RUNS_KEPT) {
    const i = ctx.runs.findIndex((r) => r.done);
    if (i < 0) break;
    ctx.runs.splice(i, 1);
  }
}

/** A run ended, however it ended: say so, then hand its seat on. */
function seatFreed(ctx, run, done) {
  run.done = done;
  persistDispatch(ctx);
  ctx.events.broadcast('dispatch', { pid: run.pid, ...done });
  drain(ctx);
}

/**
 * The seats and the line, on disk, so a server restart is free: the queue was
 * once memory alone, and every restart dropped the line and lost track of the
 * runs still going. Beside the log, since it describes the same runs.
 */
function dispatchPath() {
  return join(dirname(configPath()), 'dispatch.json');
}

function persistDispatch(ctx) {
  const record = {
    runs: live(ctx).map((r) => ({ pid: r.pid, id: r.triageId, startedAt: r.startedAt })),
    queue: ctx.queue,
  };
  try {
    writeFileSync(dispatchPath(), JSON.stringify(record));
  } catch {
    // A home dir that refuses the write costs the restart-safety, not the run.
  }
}

/**
 * On start: pick the seats and the line back up. A run whose pid is still
 * alive is adopted — not a child, so its exit is watched by asking the kernel
 * every couple of seconds, and its exit code is unknowable (`null`). Dead
 * pids free their seats, and the line resumes at once.
 */
// ponytail: `kill -0` alone; a recycled pid would hold a seat until that
// process exits — check /proc/<pid>/cmdline for "claude" if it ever happens.
function restoreDispatch(ctx) {
  let saved;
  try {
    saved = JSON.parse(readFileSync(dispatchPath(), 'utf8'));
  } catch {
    return;
  }
  ctx.queue = Array.isArray(saved.queue) ? saved.queue : [];
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const r of Array.isArray(saved.runs) ? saved.runs : []) {
    if (!r.pid || !alive(r.pid)) continue;
    const adopted = { pid: r.pid, triageId: r.id ?? null, startedAt: r.startedAt, done: undefined };
    remember(ctx, adopted);
    const poll = setInterval(() => {
      if (alive(r.pid)) return;
      clearInterval(poll);
      seatFreed(ctx, adopted, { code: null, signal: null });
    }, 2000);
    poll.unref();
  }
  drain(ctx);
}

/**
 * Auto-dispatch: with `dispatch.auto` on, a new arrival is a new backlog run
 * without anyone pressing a key. Gated on *newcomers*, not on "anything still
 * awaits the pass": a card the pass parks or leaves triaged would otherwise
 * re-trigger a run every time the seat freed, forever, at a model call each.
 */
function maybeAutoDispatch(ctx) {
  if (!ctx.config.dispatch?.auto) return;
  if (!canSeat(ctx, null) || ctx.queue.length) return;
  const waiting = buildState(ctx.config).suggestions.filter((s) => pendingPass(s));
  const newcomers = waiting.filter((s) => !ctx.autoSeen.has(s.id));
  ctx.autoSeen = new Set(waiting.map((s) => s.id));
  if (!newcomers.length) return;
  launch(ctx, null).catch(() => {
    // claude would not start; the next change tries again.
  });
}

/**
 * Seats freed, or the line grew: the head of the line takes a seat while
 * there is one it can take. Strictly in order — a backlog entry at the head
 * waits for the seats to empty, and holds the entries behind it, rather than
 * being overtaken forever by fenced ones. Each entry is re-gated when its
 * turn comes: the run that just ended may have moved it, and a run fenced to
 * a card that needs nothing is a wasted model call.
 */
async function drain(ctx) {
  while (ctx.queue.length && canSeat(ctx, ctx.queue[0])) {
    const id = ctx.queue.shift();
    persistDispatch(ctx);
    try {
      passPending(ctx, id);
      await launch(ctx, id);
    } catch {
      // Nothing to do, or claude would not start: the next in line gets a turn.
      // Nobody is on the wire to tell; the log line the spawner writes is the
      // record of what did run.
    }
  }
  // The line is empty: if arrivals came in during the runs, auto takes them.
  if (!ctx.queue.length) maybeAutoDispatch(ctx);
}

/**
 * One detached `claude` run working the whole backlog through the kaizen
 * skill. Detached and logged to a file rather than held: triage can outlive a
 * server restart, and the log is where a run that never wrote anything
 * explains itself. `bypassPermissions` because the run is headless — triage
 * labels files and changes no code, but it still reads repos and shells out,
 * and a permission prompt nobody can see is a hang.
 */
// ponytail: model pinned and one agent per run — make the model config, or fan
// out per suggestion, when one context stops covering the backlog.
function spawnTriage(id) {
  const log = join(dirname(configPath()), 'dispatch.log');
  const out = openSync(log, 'a');
  // The id rides as the skill's argument, which fences the pass to that one
  // suggestion; no id means the whole backlog.
  const child = spawn(
    'claude',
    [
      '-p',
      id ? `/kaizen:triage ${id}` : '/kaizen:triage',
      '--model',
      'claude-fable-5',
      '--permission-mode',
      'bypassPermissions',
    ],
    { cwd: homedir(), detached: true, stdio: ['ignore', out, out] },
  );
  child.unref();
  // The runs share one append-only file; this line is the only boundary
  // between them. Written on the child's own fd before it can produce output,
  // so it always precedes the run it labels.
  writeSync(out, `--- ${new Date().toISOString()} pid ${child.pid ?? '?'} ${id ?? 'backlog'} ---\n`);
  closeSync(out);
  return child;
}

/* --------------------------------------------------------------- serve ---- */

export function createApp(config, deps = {}) {
  const pkg = JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf8'));
  // Normalised once here so no route has to guard against a block the caller
  // simply did not mention.
  const ctx = {
    config: withDefaults(config),
    version: pkg.version,
    runs: [],
    queue: [],
    autoSeen: new Set(),
  };
  ctx.spawnClaude = deps.spawnClaude ?? spawnTriage;
  ctx.events = createEventStream(ctx);
  ctx.onChange = () => maybeAutoDispatch(ctx);
  restoreDispatch(ctx);
  if (ctx.config.dispatch?.auto) {
    ctx.events.watch();
    maybeAutoDispatch(ctx);
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${url.pathname}`;

    // The one route the table cannot hold: every handler in it returns a body
    // that json() writes with a content-length and ends, and this response has
    // to stay open. One special case beats teaching seven routes about streaming.
    if (key === 'GET /api/events') return ctx.events.subscribe(req, res);

    const handler = routes[key];

    if (!handler) {
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: `no route ${key}` });
      // There is no web app any more; the front end is the TUI. Anyone who
      // reaches this in a browser gets told where to go rather than a 404.
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('kaizen: this is the local API. The front end is the terminal UI — run `kaizen tui`.\n');
    }
    try {
      json(res, 200, await handler(req, res, ctx));
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) console.error(e);
      json(res, status, e.fields ? { error: e.message, errors: e.fields } : { error: e.message });
    }
  });
}

/* ------------------------------------------------------------- pidfile ---- */

const HEARTBEAT_TOUCH_MS = 15_000;
const HEARTBEAT_STALE_MS = 60_000;

/**
 * Nothing ties a server to the session that started it, so a stale one can
 * outlive its terminal and the next `serve` only sees EADDRINUSE. The pidfile
 * plus a heartbeat mtime turns that into a diagnosis. Deliberately no
 * auto-kill: replacing a live process is a decision, not a default.
 */
// Beside the config, because that is where kaizen state lives — and configPath
// honours KAIZEN_CONFIG, so tests get an isolated pidfile for free.
function pidfilePath(explicit) {
  return explicit ?? join(dirname(configPath()), 'server.pid');
}

/** One human sentence about who holds the port, from the pidfile if any. */
export function describePortHolder(port, pidfile = pidfilePath()) {
  if (!existsSync(pidfile)) {
    return `Port ${port} is in use — kaizen may already be running (no pidfile to confirm)`;
  }
  const pid = Number(readFileSync(pidfile, 'utf8').trim());
  const age = Math.round((Date.now() - statSync(pidfile).mtimeMs) / 1000);
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    /* ESRCH: gone; EPERM would mean alive-but-not-ours, impossible on loopback-local use */
  }
  if (!alive)
    return `Port ${port} is in use by another process — the last kaizen server (pid ${pid}) is gone`;
  if (age * 1000 > HEARTBEAT_STALE_MS) {
    return `A kaizen server (pid ${pid}) holds port ${port} but its heartbeat is ${age}s old — it may be hung. Kill ${pid} to replace it.`;
  }
  return `kaizen is already running (pid ${pid}, heartbeat ${age}s ago) on port ${port}`;
}

export function startServer(config, { pidfile } = {}) {
  const { host, port } = config.server ?? { host: '127.0.0.1', port: 7777 };
  const server = createApp(config);
  const pidPath = pidfilePath(pidfile);

  return new Promise((resolvePromise, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') console.error(describePortHolder(port, pidPath));
      reject(e);
    });
    server.listen(port, host, () => {
      try {
        mkdirSync(dirname(pidPath), { recursive: true });
        writeFileSync(pidPath, `${process.pid}\n`);
        const beat = setInterval(() => {
          const now = new Date();
          try {
            utimesSync(pidPath, now, now);
          } catch {
            /* removed underneath us — recreated on next start */
          }
        }, HEARTBEAT_TOUCH_MS);
        beat.unref();
        server.on('close', () => {
          clearInterval(beat);
          try {
            unlinkSync(pidPath);
          } catch {
            /* already gone */
          }
        });
      } catch (e) {
        // A server that runs without a pidfile is degraded, not broken.
        console.error(`kaizen: no pidfile — ${e.message}`);
      }
      console.log(`kaizen api → http://${host}:${port}   (front end: kaizen tui)`);
      resolvePromise(server);
    });
  });
}

// Allow `node app/server/index.mjs` directly, for development.
if (process.argv[1] && process.argv[1].endsWith('server/index.mjs')) {
  const { config, exists } = loadConfig();
  if (!exists) {
    console.error('No config. Run `kaizen init` first.');
    process.exit(1);
  }
  await startServer(config);
}

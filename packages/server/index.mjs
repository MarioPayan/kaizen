/**
 * The local API.
 *
 * A small route table, `node:http`, bound to loopback. Every route is a file
 * read, a file write, or a git call — save one, which starts a detached run
 * (opencode to do, claude to check) — there is no layer here worth a framework.
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
  renameSync,
  openSync,
  closeSync,
  writeSync,
  readSync,
} from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildState,
  configPath,
  defaultConfig,
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
  isTerminal,
  pendingPass,
  runnerOf,
  nextStatuses,
  statusIds,
  missingRequirements,
  requirementsFor,
  writeSection,
  suggestionId,
  patchIdentity,
  spec,
  suggestionProject,
} from '@kaizen/core';
import { createEventStream } from './events.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

class HttpError extends Error {
  constructor(status, message, fields, extra) {
    super(message);
    this.status = status;
    // Per-field messages, when the failure has them. The Settings form reads
    // these; everything else reads `message`.
    this.fields = fields;
    // Anything else the refusal wants to say beside its sentence — `apply`
    // says whether it parked the card, so a lane walk knows to keep going.
    this.extra = extra;
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
function assertRequirements(config, id, to, overrides = {}) {
  const { path } = suggestionFile(config, id);
  const { data, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  const missing = missingRequirements(to, {
    data: { ...data, ...overrides },
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

/** The attended decision approves exact patch bytes, not a mutable filename. */
function approval(config, id, to) {
  const decision = spec().phases.find((p) => p.attended);
  if (to !== decision?.produces) return {};
  const { path } = suggestionFile(config, id);
  const sidecar = path.replace(/\.md$/, '.patch');
  if (!existsSync(sidecar)) throw new HttpError(409, 'cannot approve without a proposal patch');
  return { approved_patch: patchIdentity(readFileSync(sidecar)) };
}

/**
 * The third gate, for a status the runner wrote provisionally.
 *
 * A card wearing `needs_review` is where its status says only once the reviewer
 * agrees — so a forward move from the board, or a sweep of the planned lane,
 * must not carry an unchecked plan into `approved`. The way out is never gated:
 * closing a card is the one move that owes the reviewer nothing.
 */
function assertChecked(config, id, to) {
  const { path } = suggestionFile(config, id);
  const { data } = parseFrontmatter(readFileSync(path, 'utf8'));
  if (!data.needs_review || isTerminal(to)) return;
  throw new HttpError(
    409,
    `${id.split('/').at(-1)} is waiting on ${data.needs_review}'s check — a runs it; it cannot become "${to}" until that clears.`,
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
async function assertApplyable(cwd, patch, liveTree = {}) {
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
    const dirty = status
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => l.slice(3));
    const skills = liveTree.skills && resolve(liveTree.skills);
    const claims = new Set((liveTree.claimedScopes ?? []).map((scope) => resolve(cwd, scope)));
    const unclaimed = skills
      ? dirty.filter((file) => {
          const absolute = resolve(cwd, file);
          const fromSkills = relative(skills, absolute);
          return (
            fromSkills && !fromSkills.startsWith('..') && !isAbsolute(fromSkills) && !claims.has(absolute)
          );
        })
      : [];
    const diagnosis = unclaimed.length
      ? ` Unclaimed live-tree edit with no open card for its scope: ${unclaimed.join(', ')}; a runner may have written outside its proposal worktree.`
      : '';
    throw new HttpError(
      409,
      `the patch's own files have uncommitted work — commit or stash first: ${dirty.join(', ')}.${diagnosis}`,
    );
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
        // Which binary has the seat — the agents tab names it, and the
        // footer's "pass done" says whose.
        runner: r.runner ?? '',
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
    // Flipping auto on is the ask: send the runners at what is waiting, now.
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
  /**
   * One write to one suggestion: a status move, an answer to its block, or both.
   *
   * `blockedOn` is settable on its own because answering a block is not a status
   * move — the card stays exactly where it is, it just stops waiting on you. An
   * empty string is a real value here, and the clear: the field's absence and
   * its emptiness mean different things, so the key's presence is what decides.
   */
  'POST /api/suggestion': async (req, _res, ctx) => {
    const body = await readBody(req);
    const { id, status, notes } = body;
    const { path } = suggestionFile(ctx.config, id);
    const patch = {};
    if ('blockedOn' in body) patch.blocked_on = String(body.blockedOn ?? '');
    if (status !== undefined) {
      const to = assertSettable(status);
      const from = currentStatus(ctx.config, id);
      // Setting a status to what it already is is a double-click, not an illegal
      // move. Notes still land, so a re-decision can add its reason.
      if (from !== to) {
        assertTransition(from, to, id);
        assertChecked(ctx.config, id, to);
        const approved = approval(ctx.config, id, to);
        assertRequirements(ctx.config, id, to, approved);
        Object.assign(patch, approved);
        const decision = spec().phases.find((p) => p.attended);
        const prior = spec().statuses.find((s) => (s.next ?? []).includes(decision?.produces));
        if (from === decision?.produces && to === prior?.id) patch.approved_patch = '';
      }
      patch.status = to;
      if (notes) patch.notes = notes;
    }
    if (!Object.keys(patch).length) {
      throw new HttpError(400, 'nothing to write — send a status, a blockedOn, or both');
    }
    writeFrontmatter(path, patch);
    return { id, ...patch };
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
        assertChecked(ctx.config, s.id, to);
        const approved = approval(ctx.config, s.id, to);
        assertRequirements(ctx.config, s.id, to, approved);
        const { path } = suggestionFile(ctx.config, s.id);
        writeFrontmatter(path, { status: to, ...approved });
      } catch {
        continue;
      }
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
    const { pending, state } = passPending(ctx, id);
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
      const child = await launch(ctx, id, state);
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
    const applyState = buildState(ctx.config);
    const suggestion = applyState.suggestions.find((s) => s.id === id);
    let project;
    try {
      project = suggestionProject(applyState, suggestion);
    } catch (e) {
      throw new HttpError(409, e.message);
    }
    if (project ? !ctx.config.scan?.writable : !target.writable) {
      const owner = project ? `project "${project}"` : `target "${target.name}"`;
      throw new HttpError(403, `${owner} is read-only`);
    }
    // Apply and commit at the repo root that owns the skills dir, not the dir
    // itself — a target whose skills sit inside a larger repo (kaizen's own
    // skills/ folder) carries patches rooted at that repo. Project skills file
    // into another target's feedback directory, but their patches belong to the
    // discovered project and use its independent writability gate.
    const root = (await git(project ?? target.skills, ['rev-parse', '--show-toplevel'])).trim();
    // The same gate as any other move. Applying is the one transition the server
    // performs on its own, which is exactly why it should not be the one that
    // skips the check.
    assertTransition(currentStatus(ctx.config, id), 'applied', id);
    // No requirements check here. `requires` lists what a phase *produces*, and
    // the apply phase produces `applied_sha` — which this handler writes a few
    // lines below, once git has returned one. Demanding it up front is a gate
    // that can never open. The patch check further down is the real precondition.

    const patch = path.replace(/\.md$/, '.patch');
    // A landing that cannot happen because of the *patch* parks the card with
    // the reason, so the board shows it standing with the flag up and its ways
    // out, instead of flashing one truncated line and leaving it in approved
    // to fail the same way tomorrow — fourteen cards did exactly that. A tree
    // that is not ready (dirty paths, something staged, read-only) is about
    // the tree, not the card, and stays a transient refusal.
    const park = (why) => {
      const reason = `apply: ${String(why).trim().split('\n').at(-1)}`;
      writeFrontmatter(path, { blocked_on: reason });
      throw new HttpError(422, reason, undefined, { parked: true });
    };
    if (!existsSync(patch)) park('no proposal patch for this suggestion yet');
    const { data } = parseFrontmatter(readFileSync(path, 'utf8'));
    const currentIdentity = patchIdentity(readFileSync(patch));
    if (!data.approved_patch || data.approved_patch !== currentIdentity) {
      throw new HttpError(
        409,
        'the proposal patch changed after approval — return it to planning and approve it again',
      );
    }

    if (ctx.config.applyGuards?.requireCleanTree !== false) {
      const claimedScopes = applyState.suggestions
        .filter(
          (candidate) => candidate.target === target.name && !isTerminal(candidate.status) && candidate.scope,
        )
        .map((candidate) => candidate.scope);
      await assertApplyable(root, patch, { skills: target.skills, claimedScopes });
    }
    if (ctx.config.applyGuards?.requireDiffApplies !== false) {
      try {
        await git(root, ['apply', '--check', patch]);
      } catch (e) {
        park(e.message);
      }
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

    // The commit that lands a fix closes the cards that were riding on it —
    // the members a triage pass parked on this one (`blocked_on` naming it),
    // which is how Step 4 says a scope's members reference their lead. This is
    // what the 27 orphans were: the drain marked only the suggestion named in
    // its trailer, and everything else rotted as open work. It used to close
    // every card sharing the *scope*, and the first real landing superseded an
    // unrelated finding that merely lived in the same file: a scope is one
    // place, not always one fix. Mechanical, with the sha recorded so the
    // trail survives.
    const state = buildState(ctx.config);
    let closed = 0;
    for (const s of state.suggestions) {
      if (s.id === id || s.blockedBy !== id) continue;
      if (!canTransition(s.status, 'superseded')) continue;
      writeFrontmatter(suggestionFile(ctx.config, s.id).path, {
        status: 'superseded',
        superseded_by: sha,
      });
      closed++;
    }
    // A landed change is the runners' work again — opencode reviews it, claude
    // verifies — so the landing puts the card in line itself. The first real
    // drain stalled here: the chain hands runs to each other, but nothing
    // handed the server's own act on to a run.
    const landed = state.suggestions.find((s) => s.id === id);
    if (
      landed &&
      pendingPass(landed) &&
      !ctx.queue.includes(id) &&
      !live(ctx).some((r) => r.triageId === id)
    ) {
      ctx.queue.push(id);
      persistDispatch(ctx);
      ctx.events.broadcast('dispatch', { queued: ctx.queue.length });
      drain(ctx);
    }
    return { id, sha, closed };
  },

  /**
   * One of the ways out of a parked card, picked from the board's menu.
   *
   * Each choice is a short sequence of writes the TUI should not have to know,
   * and every one of them goes through the same three gates a key press does —
   * the route composes them, it does not bypass them. What the user typed lands
   * under `## Answer`, which is the brief the next run reads beside any verdict.
   */
  'POST /api/unblock': async (req, _res, ctx) => {
    const { id, choice, text = '', target: targetName } = await readBody(req);
    const { path, target } = suggestionFile(ctx.config, id);
    const from = currentStatus(ctx.config, id);
    const { data } = parseFrontmatter(readFileSync(path, 'utf8'));
    const said = String(text).trim();
    const stamp = new Date().toISOString().slice(0, 10);

    // A status move, gated like any other, with the flag cleared in the same
    // write so the card does not land in the review lane on its way out.
    const move = (to, extra = {}) => {
      assertTransition(from, to, id);
      assertChecked(ctx.config, id, to);
      assertRequirements(ctx.config, id, to);
      writeFrontmatter(path, { status: to, blocked_on: '', ...extra });
    };
    // Back in line for whoever the card now needs, if anyone.
    const queue = () => {
      const s = buildState(ctx.config).suggestions.find((x) => x.id === id);
      if (!s || !pendingPass(s) || ctx.queue.includes(id) || live(ctx).some((r) => r.triageId === id))
        return false;
      ctx.queue.push(id);
      persistDispatch(ctx);
      ctx.events.broadcast('dispatch', { queued: ctx.queue.length });
      drain(ctx);
      return true;
    };

    switch (choice) {
      case 'replan': {
        // The yes was for a patch that no longer lands, or the plan was found
        // wanting: back to triaged for a new plan, with why under Answer.
        if (data.blocked_on) writeSection(path, 'Answer', `${stamp} — sent back: ${data.blocked_on}`);
        move('triaged');
        return {
          id,
          did: queue() ? 'sent back for a new plan — opencode has it' : 'sent back for a new plan',
        };
      }
      case 'clear': {
        writeFrontmatter(path, { blocked_on: '' });
        return { id, did: queue() ? 'cleared — a run has it' : 'cleared' };
      }
      case 'answer': {
        if (!said) throw new HttpError(400, 'an answer needs words');
        writeSection(path, 'Answer', `${stamp} — ${said}`);
        writeFrontmatter(path, { blocked_on: '' });
        return { id, did: queue() ? 'answered — a run has it' : 'answered' };
      }
      case 'supersede': {
        if (!said) throw new HttpError(400, 'say where the fix lives');
        writeSection(path, 'Answer', `${stamp} — superseded by hand: ${said}`);
        move('superseded');
        return { id, did: 'superseded' };
      }
      case 'reject': {
        move('rejected');
        return { id, did: 'rejected' };
      }
      case 'retarget': {
        // The card was filed under the wrong repo root. Retargeting changes
        // where it lives, not how far it has advanced through the lifecycle.
        const to = resolveTargets(ctx.config).find((t) => t.name === targetName);
        if (!to) throw new HttpError(404, `unknown target "${targetName}"`);
        if (!to.writable || !to.feedback) throw new HttpError(403, `target "${to.name}" cannot take a card`);
        if (to.name === target.name)
          throw new HttpError(409, `${id.split('/').at(-1)} is already under "${to.name}"`);
        const { skill, file } = parseSuggestionId(id);
        const dir = join(to.feedback, skill);
        mkdirSync(dir, { recursive: true });
        const dest = join(dir, file);
        if (existsSync(dest)) throw new HttpError(409, `"${to.name}" already holds ${file}`);
        writeSection(
          path,
          'Answer',
          `${stamp} — moved from target "${target.name}" to "${to.name}": scope belongs there`,
        );
        writeFrontmatter(path, { blocked_on: '' });
        renameSync(path, dest);
        const patch = path.replace(/\.md$/, '.patch');
        if (existsSync(patch)) renameSync(patch, dest.replace(/\.md$/, '.patch'));
        const moved = suggestionId(to.name, skill, file);
        const s = buildState(ctx.config).suggestions.find((x) => x.id === moved);
        let queued = false;
        if (s && pendingPass(s) && !ctx.queue.includes(moved)) {
          ctx.queue.push(moved);
          persistDispatch(ctx);
          ctx.events.broadcast('dispatch', { queued: ctx.queue.length });
          drain(ctx);
          queued = true;
        }
        return { id: moved, did: queued ? `moved to ${to.name} — opencode has it` : `moved to ${to.name}` };
      }
      default:
        throw new HttpError(400, 'choice must be one of replan, clear, answer, supersede, reject, retarget');
    }
  },

  'POST /api/revert': async (req, _res, ctx) => {
    const { sha, target: targetName, id } = await readBody(req);
    if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) throw new HttpError(400, 'sha is not a commit hash');
    let t;
    let project;
    if (id) {
      ({ target: t } = suggestionFile(ctx.config, id));
      const state = buildState(ctx.config);
      const suggestion = state.suggestions.find((s) => s.id === id);
      try {
        project = suggestionProject(state, suggestion);
      } catch (e) {
        throw new HttpError(409, e.message);
      }
    } else {
      t = resolveTargets(ctx.config).find((x) => x.name === targetName);
    }
    if (!t) throw new HttpError(404, `unknown target "${targetName}"`);
    if (project ? !ctx.config.scan?.writable : !t.writable) {
      const owner = project ? `project "${project}"` : `target "${t.name}"`;
      throw new HttpError(403, `${owner} is read-only`);
    }
    const root = (await git(project ?? t.skills, ['rev-parse', '--show-toplevel'])).trim();
    await assertCleanTree(root);
    await git(root, ['revert', '--no-edit', sha]);
    return { reverted: sha };
  },
};

/* ------------------------------------------------------------ dispatch ---- */

/**
 * The gate: what a run could move if it started now. With an id the run is
 * fenced to one suggestion — the skill accepts it as an argument. Without one
 * it takes the backlog. Either way the gate is `pendingPass`, not the untriaged
 * count: a run also plans the triaged, re-plans the failed, reviews the applied
 * and checks the flagged, and gating on triage alone refused exactly those —
 * while a parked card looks pending by status and has nothing for a run to do.
 *
 * Returns the state it read, so the launch that follows does not scan again.
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
    return { pending: 1, state };
  }
  const pending = state.suggestions.filter((s) => pendingPass(s)).length;
  if (!pending) throw new HttpError(422, 'nothing for a pass to do — all work is decided or yours');
  return { pending, state };
}

/** The cards a run keyed on `id` could touch right now, each with whose move it is. */
function pendingCards(state, id) {
  return state.suggestions.filter((s) => (id === null || s.id === id) && pendingPass(s));
}

/**
 * The same, as `card → runner` pairs. A card that changes hands is a new pair,
 * and a new pair is the only thing that earns another run — see `chain`.
 */
function pendingPairs(state, id) {
  return new Set(pendingCards(state, id).map((s) => `${s.id} → ${runnerOf(s)}`));
}

/**
 * Who a run keyed on `id` is for. A fenced run is whoever its card names. The
 * backlog goes to a reviewer first while any card is waiting on one — a check
 * finishes work already done and drains toward you — and otherwise to whoever
 * the first pending card needs. Empty when nothing pends, which `passPending`
 * has already refused.
 */
function runnerFor(state, id) {
  const pending = pendingCards(state, id);
  const first = pending.find((s) => s.needsReview) ?? pending[0];
  return first ? runnerOf(first) : '';
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
async function launch(ctx, id, state = buildState(ctx.config)) {
  const runner = runnerFor(state, id);
  let child;
  try {
    child = ctx.spawn(runner, id);
  } catch (e) {
    throw new HttpError(500, `could not start ${runner || 'a run'} — ${e.message}`);
  }
  await new Promise((launched, failed) => {
    child.once('spawn', launched);
    child.once('error', (e) => failed(new HttpError(500, `could not start ${runner} — ${e.message}`)));
  });
  // `done` rather than `exitCode`: a signal death leaves exitCode null, which
  // reads as still-running and would wedge the seat forever. The broadcast is
  // what tells the TUI the run ended even when it wrote no files.
  child.once('exit', (code, signal) => seatFreed(ctx, child, { code, signal }));
  // What the run is on, who has it and since when, so the agents tab can say
  // more than "a pid exists". Recorded here, not in the spawner — tests stub
  // that. `seen` is what the run found waiting; the chain compares against it.
  child.startedAt = Date.now();
  child.triageId = id;
  child.runner = runner;
  child.seen = pendingPairs(state, id);
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
  chain(ctx, run);
  drain(ctx);
}

/**
 * The hand-off between runners, so one key press is the whole unattended
 * stretch: opencode plans and flags, claude checks, and neither has to be sent
 * by hand. A run that ended well and left work that was not there when it
 * started — a card now wanting a different runner — puts its own key back in
 * line, where it is re-gated like any other entry.
 *
 * Everything else ends here: a crash, a run that moved nothing, a card that
 * is now yours. Each hop has to produce something new, which is what stops
 * two runners bouncing one card between them forever.
 */
function chain(ctx, run) {
  if (run.done?.code !== 0 || !run.seen) return;
  const now = pendingPairs(buildState(ctx.config), run.triageId);
  const fresh = [...now].some((pair) => !run.seen.has(pair));
  if (!fresh || ctx.queue.includes(run.triageId)) return;
  ctx.queue.push(run.triageId);
  persistDispatch(ctx);
  ctx.events.broadcast('dispatch', { queued: ctx.queue.length });
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
    runs: live(ctx).map((r) => ({ pid: r.pid, id: r.triageId, runner: r.runner, startedAt: r.startedAt })),
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
    // No `seen`: an adopted run's exit code is unknowable, so it never chains.
    const adopted = {
      pid: r.pid,
      triageId: r.id ?? null,
      runner: r.runner ?? '',
      startedAt: r.startedAt,
      done: undefined,
    };
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
  const state = buildState(ctx.config);
  // Pairs, not ids: a card that changed hands — opencode flagged it for claude
  // — is new work, even though the card itself was seen before.
  const waiting = pendingPairs(state, null);
  const newcomers = [...waiting].filter((pair) => !ctx.autoSeen.has(pair));
  ctx.autoSeen = waiting;
  if (!newcomers.length) return;
  launch(ctx, null, state).catch(() => {
    // The runner would not start; the next change tries again.
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
      const { state } = passPending(ctx, id);
      await launch(ctx, id, state);
    } catch {
      // Nothing to do, or the runner would not start: the next in line gets a
      // turn. Nobody is on the wire to tell; the log line the spawner writes
      // is the record of what did run.
    }
  }
  // The line is empty: if arrivals came in during the runs, auto takes them.
  if (!ctx.queue.length) maybeAutoDispatch(ctx);
}

/** The plugin root: where the skill the runners follow lives. */
const ROOT = resolve(here, '..', '..');

/**
 * What each runner the spec names is started with. The id rides along as the
 * fence — the skill accepts it as an argument — and no id means the backlog.
 *
 * claude has the skill as a slash command and is sent in its `review` mode:
 * the checker, never the doer. opencode has no plugin root and no commands, so
 * it is told the path the skill's commands expand and which mode of the skill
 * is its own. `bypassPermissions` for claude and opencode's own config for
 * opencode, because both are headless — a permission prompt nobody can see is
 * a hang. Claude's model is a config value; opencode's model is the ChatGPT
 * subscription's, and which one is config too.
 */
const RUNNERS = {
  claude: (id, model) => [
    'claude',
    [
      '-p',
      id ? `/kaizen:triage review ${id}` : '/kaizen:triage review',
      '--model',
      model,
      '--permission-mode',
      'bypassPermissions',
    ],
  ],
  opencode: (id, model) => [
    'opencode',
    [
      'run',
      '--dir',
      homedir(),
      '-m',
      model,
      `You are opencode, running kaizen's unattended pass: the runner, never the reviewer. ` +
        `CLAUDE_PLUGIN_ROOT is already set in your environment (${ROOT}), so the skill's ` +
        `commands resolve as written. Read ${ROOT}/skills/kaizen/SKILL.md and follow its Runner mode for ` +
        `${id ? `the suggestion ${id}` : 'the whole backlog'}. Never push. ` +
        `When you are done, print KAIZEN_DONE on its own line.`,
    ],
  ],
};

/**
 * One detached run. Detached and logged to a file rather than held: a run can
 * outlive a server restart, and the log is where a run that never wrote
 * anything explains itself.
 */
function spawnRun(runner, id, config) {
  const make = RUNNERS[runner];
  if (!make) throw new Error(`the spec names "${runner}" and this server cannot start it`);
  // The config's word, else the default's: `withDefaults` merges one level
  // deep, so a config that pins only one runner's model has dropped the other.
  const model = config.dispatch?.models?.[runner] ?? defaultConfig().dispatch.models[runner] ?? '';
  const [cmd, argv] = make(id, model);
  const log = join(dirname(configPath()), 'dispatch.log');
  const out = openSync(log, 'a');
  // The plugin root rides in the environment, not in the prompt: the skill's
  // commands are written against `${CLAUDE_PLUGIN_ROOT}`, and a runner whose
  // every shell call is a fresh process cannot `export` it once — the first
  // real run lost a round-trip to `Cannot find module '/scripts/cli.mjs'`.
  const child = spawn(cmd, argv, {
    cwd: homedir(),
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT },
  });
  child.unref();
  // The runs share one append-only file; this line is the only boundary
  // between them. Written on the child's own fd before it can produce output,
  // so it always precedes the run it labels.
  writeSync(
    out,
    `--- ${new Date().toISOString()} pid ${child.pid ?? '?'} ${runner} ${id ?? 'backlog'} ---\n`,
  );
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
  // `(runner, id) → child`. Tests hand in one that only looks like a process —
  // and a test that forgets must not reach the real one: the day the injection
  // key was renamed, vitest started opencode against a fixture, headless and
  // with every permission granted. Under vitest there is no real spawner.
  const real = (runner, id) => spawnRun(runner, id, ctx.config);
  const refuse = () => {
    throw new Error('no spawner injected — a test must hand createApp a fake one');
  };
  ctx.spawn = deps.spawn ?? (process.env.VITEST ? refuse : real);
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
      json(res, status, { error: e.message, ...(e.fields ? { errors: e.fields } : {}), ...(e.extra ?? {}) });
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

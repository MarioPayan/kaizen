/**
 * The local API.
 *
 * Seven routes, `node:http`, bound to loopback. Every route is a file read, a file
 * write, or a git call — there is no layer here worth a framework.
 *
 * Two things are not negotiable and are enforced rather than documented:
 *   - the socket binds 127.0.0.1, because these routes write files and shell out
 *     to git, and that binding is the entire security boundary
 *   - every caller-supplied path is resolved and asserted inside a configured
 *     target before it is touched
 */
import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildState } from '../../scripts/lib/scan.mjs';
import { resolveTargets, saveConfig, validateConfig, loadConfig } from '../../scripts/lib/config.mjs';
import { assertInside, parseSuggestionId } from '../../scripts/lib/paths.mjs';
import { writeFrontmatter } from '../../scripts/lib/suggestion.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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
  const candidate = join(t.feedback, skill, file);
  try {
    assertInside([t.feedback], candidate, 'suggestion');
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  if (!existsSync(candidate)) throw new HttpError(404, `no such suggestion: ${id}`);
  return { path: candidate, target: t };
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
 * Applying into a dirty tree mixes the user's in-flight work into a kaizen commit
 * and makes `git revert` stop being a clean undo. Refuse, and name the files.
 */
async function assertCleanTree(cwd) {
  const status = await git(cwd, ['status', '--porcelain']);
  if (status.trim()) {
    const files = status
      .trim()
      .split('\n')
      .map((l) => l.slice(3))
      .join(', ');
    throw new HttpError(409, `working tree is not clean — commit or stash first: ${files}`);
  }
}

/* -------------------------------------------------------------- routes ---- */

const routes = {
  'GET /api/health': async (_req, _res, ctx) => ({
    ok: true,
    version: ctx.version,
    targets: ctx.config.targets.length,
  }),

  'GET /api/state': async (_req, _res, ctx) => buildState(ctx.config),

  'GET /api/config': async (_req, _res, ctx) => ({ config: ctx.config, errors: validateConfig(ctx.config) }),

  'POST /api/config': async (req, _res, ctx) => {
    const next = await readBody(req);
    const errors = validateConfig(next);
    if (errors.length) throw new HttpError(400, errors.join('; '));
    saveConfig(next);
    ctx.config = next;
    return { config: next };
  },

  // Rendering a skill means reading its markdown from wherever it actually lives.
  // Nothing is copied into kaizen, so this is always the current file on disk.
  'GET /api/skill': async (req, _res, ctx) => {
    const path = new URL(req.url, 'http://localhost').searchParams.get('path');
    if (!path) throw new HttpError(400, 'path is required');
    const roots = resolveTargets(ctx.config).flatMap((t) => [t.skills, t.feedback]);
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
    const allowed = ['new', 'proposed', 'approved', 'rejected', 'superseded'];
    if (!allowed.includes(status)) throw new HttpError(400, `status must be one of ${allowed.join(', ')}`);
    const { path } = suggestionFile(ctx.config, id);
    writeFrontmatter(path, notes ? { status, notes } : { status });
    return { id, status };
  },

  /** Approving a cluster is one decision, so applying one is one call. */
  'POST /api/cluster': async (req, _res, ctx) => {
    const { id, status } = await readBody(req);
    const state = buildState(ctx.config);
    const cluster = state.clusters.find((c) => c.id === id);
    if (!cluster) throw new HttpError(404, `no such cluster: ${id}`);
    for (const member of cluster.members) {
      const { path } = suggestionFile(ctx.config, member);
      writeFrontmatter(path, { status, cluster: cluster.id });
    }
    return { id, status, updated: cluster.members.length };
  },

  'POST /api/apply': async (req, _res, ctx) => {
    const { id } = await readBody(req);
    const { path, target } = suggestionFile(ctx.config, id);
    if (!target.writable) throw new HttpError(403, `target "${target.name}" is read-only`);

    const patch = path.replace(/\.md$/, '.patch');
    if (!existsSync(patch)) throw new HttpError(422, 'no proposal patch for this suggestion yet');

    if (ctx.config.applyGuards?.requireCleanTree !== false) await assertCleanTree(target.skills);
    if (ctx.config.applyGuards?.requireDiffApplies !== false) {
      await git(target.skills, ['apply', '--check', patch]);
    }

    await git(target.skills, ['apply', patch]);
    await git(target.skills, ['add', '-A']);
    await git(target.skills, [
      'commit',
      '-m',
      `kaizen: ${id.split('/').at(-1).replace(/\.md$/, '')}`,
      '-m',
      `Kaizen-Suggestion: ${id}`,
    ]);
    const sha = (await git(target.skills, ['rev-parse', 'HEAD'])).trim();
    writeFrontmatter(path, { status: 'applied', applied_sha: sha });
    return { id, sha };
  },

  'POST /api/revert': async (req, _res, ctx) => {
    const { sha, target: targetName } = await readBody(req);
    if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) throw new HttpError(400, 'sha is not a commit hash');
    const t = resolveTargets(ctx.config).find((x) => x.name === targetName);
    if (!t) throw new HttpError(404, `unknown target "${targetName}"`);
    if (!t.writable) throw new HttpError(403, `target "${t.name}" is read-only`);
    await assertCleanTree(t.skills);
    await git(t.skills, ['revert', '--no-edit', sha]);
    return { reverted: sha };
  },
};

/* --------------------------------------------------------- static files ---- */

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let file = join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
  try {
    assertInside([DIST], file, 'asset');
  } catch {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(file) || (await stat(file)).isDirectory()) file = join(DIST, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('The app has not been built yet. Run: npm --prefix app run build');
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(body);
}

/* --------------------------------------------------------------- serve ---- */

export function createApp(config) {
  const pkg = JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf8'));
  const ctx = { config, version: pkg.version };

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];

    if (!handler) {
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: `no route ${key}` });
      return serveStatic(req, res);
    }
    try {
      json(res, 200, await handler(req, res, ctx));
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) console.error(e);
      json(res, status, { error: e.message });
    }
  });
}

export function startServer(config) {
  const { host, port } = config.server ?? { host: '127.0.0.1', port: 7777 };
  const server = createApp(config);

  return new Promise((resolvePromise, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        // Almost always an instance already running. Say that rather than
        // starting a second one on a port the user has to go looking for.
        console.error(`Port ${port} is in use — kaizen may already be running at http://${host}:${port}`);
      }
      reject(e);
    });
    server.listen(port, host, () => {
      console.log(`kaizen → http://${host}:${port}`);
      if (!existsSync(DIST)) console.log('(app not built yet — run: npm --prefix app run build)');
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

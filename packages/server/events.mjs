/**
 * Live updates: the server tells the page when the files under it changed.
 *
 * The app used to refetch on window focus only, on the reasoning that watching a
 * directory all day costs more than it returns. That priced a watcher as a poll
 * loop. `fs.watch` is not polling — inotify delivers an event only when a file
 * actually changes, so watching a handful of small feedback directories costs a
 * few file descriptors and zero wakeups while nothing happens.
 */
import { watch } from 'node:fs';
import { resolveTargets } from '@kaizen/core';

const DEBOUNCE_MS = 300;
const HEARTBEAT_MS = 25_000;

/** Editors write swap and backup files into the same directory. */
const INTERESTING = /\.(md|patch)$/;

export function createEventStream(ctx) {
  const clients = new Set();
  let watchers = [];
  let watching = [];
  let touched = new Set();
  let timer = null;
  let heartbeat = null;

  const send = (res, frame) => {
    if (res.writableEnded) return false;
    try {
      res.write(frame);
      return true;
    } catch {
      return false;
    }
  };

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of [...clients]) if (!send(res, frame)) drop(res);
  };

  const flush = () => {
    timer = null;
    broadcast('change', { dirs: [...touched] });
    touched = new Set();
  };

  const bump = (dir, filename) => {
    if (filename && !INTERESTING.test(filename)) return;
    touched.add(dir);
    clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
    timer.unref();
  };

  /**
   * Only the feedback directories.
   *
   * Not the skills trees: those are git repos, and `/api/apply` runs git in them,
   * so watching them would fire a storm off kaizen's own commits. Not `scan.roots`
   * either — those are unbounded and can contain `node_modules`.
   */
  function startWatchers() {
    // Two targets may name the same feedback directory; two watchers on one
    // directory means two events per change.
    const dirs = [...new Set(resolveTargets(ctx.config).map((t) => t.feedback))];
    for (const dir of dirs) {
      try {
        const w = watch(dir, { recursive: true }, (_event, filename) => bump(dir, filename));
        w.on('error', (e) => {
          console.error(`kaizen: stopped watching ${dir} — ${e.message}`);
          w.close();
          watchers = watchers.filter((x) => x !== w);
          watching = watching.filter((x) => x !== dir);
        });
        w.unref();
        watchers.push(w);
        watching.push(dir);
      } catch (e) {
        // Recursive watch on Linux needs Node >= 20.13, and `engines` only says
        // 20. A missing directory throws ENOENT here too — buildState already
        // warns about that one, so this stays quiet either way. Reported rather
        // than worked around: `watching: []` keeps the page's dot grey instead
        // of promising liveness it cannot deliver.
        console.error(`kaizen: no live updates for ${dir} — ${e.message}`);
      }
    }
    return watching;
  }

  function stopWatchers() {
    for (const w of watchers) w.close();
    watchers = [];
    watching = [];
    clearTimeout(timer);
    clearInterval(heartbeat);
    timer = null;
    heartbeat = null;
  }

  function drop(res) {
    if (!clients.delete(res)) return;
    if (!res.writableEnded) res.end();
    // Nobody is listening, so nothing needs watching. This is also what keeps
    // the test suites from hanging: they call createApp() then server.close(),
    // and eager inotify handles would hold the event loop open past both.
    if (clients.size === 0) stopWatchers();
  }

  return {
    subscribe(req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      // The client's reconnect policy, set by the server. EventSource honours
      // this on its own — there is no hand-rolled backoff anywhere, and none
      // should be added.
      res.write('retry: 3000\n\n');

      if (clients.size === 0) {
        startWatchers();
        // In development the app is served by Vite and /api is proxied, so the
        // stream crosses a proxy that may drop a silent connection. Three lines
        // beats diagnosing a half-dead stream.
        heartbeat = setInterval(() => broadcast('ping', {}), HEARTBEAT_MS);
        heartbeat.unref();
      }

      clients.add(res);
      send(res, `event: hello\ndata: ${JSON.stringify({ watching })}\n\n`);
      req.on('close', () => drop(res));
      res.on('error', () => drop(res));
    },

    /** The watched set follows the target list, which Settings can change. */
    restart() {
      if (clients.size === 0) return;
      stopWatchers();
      startWatchers();
      heartbeat = setInterval(() => broadcast('ping', {}), HEARTBEAT_MS);
      heartbeat.unref();
      broadcast('hello', { watching });
    },

    size: () => clients.size,
  };
}

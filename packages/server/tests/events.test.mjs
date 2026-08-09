/**
 * The live-update stream.
 *
 * Its own file rather than an addition to api.test.mjs, because of the
 * lifecycle: `server.close()` waits for open connections, and an SSE reader left
 * running turns a failure into a hang. Every reader here is aborted first.
 *
 * Read with fetch and a TextDecoder rather than EventSource, which is not a
 * dependable global on Node.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../index.mjs';

let server;
let base;
let root;
let feedback;

/** Collects frames until aborted. Returns a live array plus its abort handle. */
async function listen() {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        frames.push(decoder.decode(value));
      }
    } catch {
      // Aborting is the normal way this ends.
    }
  })();
  return { frames, stop: () => ac.abort(), text: () => frames.join('') };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaizen-events-'));
  feedback = join(root, 'feedback');
  mkdirSync(join(feedback, 'demo'), { recursive: true });
  mkdirSync(join(root, 'skills'), { recursive: true });

  server = createApp({
    targets: [{ name: 'user', skills: join(root, 'skills'), feedback, writable: true }],
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/events', () => {
  it('says what it is watching', async () => {
    const stream = await listen();
    await settle(150);
    expect(stream.text()).toContain('event: hello');
    expect(stream.text()).toContain(feedback);
    stream.stop();
    await settle(50);
  });

  it('debounces a burst of writes into one event', async () => {
    const stream = await listen();
    await settle(150);

    const file = join(feedback, 'demo', '2026-01-01-burst.md');
    for (const body of ['one', 'two', 'three']) {
      writeFileSync(file, `---\nskill: demo\ndate: 2026-01-01\nseverity: low\n---\n\n${body}\n`);
    }
    await settle(700);

    // Three writes, one refetch. Without the debounce every save in an editor
    // would cost the client a full directory scan.
    expect(stream.text().match(/event: change/g) ?? []).toHaveLength(1);
    stream.stop();
    await settle(50);
  });

  it('reaches every connected client', async () => {
    const a = await listen();
    const b = await listen();
    await settle(150);

    writeFileSync(join(feedback, 'demo', '2026-01-02-both.md'), '---\nskill: demo\n---\n\nx\n');
    await settle(700);

    expect(a.text()).toContain('event: change');
    expect(b.text()).toContain('event: change');
    a.stop();
    b.stop();
    await settle(50);
  });
});

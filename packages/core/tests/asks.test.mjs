/**
 * The asks corpus and the schedule that reads it.
 *
 * Two things here would fail silently and cost real money: a `--due` that says
 * yes twice for one slot (a model pass per session), and a redactor that lets a
 * URL through (every ask unique, so nothing ever recurs). Both are covered.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAsks, passDue, parseCadence, windowDays } from '../src/asks.mjs';

let root;
let history;

const DAY = 86400000;
const NOW = Date.parse('2026-08-10T12:00:00Z');

const write = (rows) => writeFileSync(history, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const prompt = (display, over = {}) => ({
  display,
  project: '/home/u/repos/demo',
  timestamp: NOW - DAY,
  sessionId: 'x',
  ...over,
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kaizen-asks-'));
  history = join(root, 'history.jsonl');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('reading the prompt log', () => {
  it('collapses the same ask into one entry and counts it', () => {
    write([
      prompt('please review this pull request for me'),
      prompt('please review this pull request for me'),
    ]);
    const asks = readAsks({ path: history, now: NOW });
    expect(asks).toHaveLength(1);
    expect(asks[0].n).toBe(2);
  });

  it('sees two asks as the same one when only the URL differs', () => {
    write([
      prompt('review https://github.com/a/b/pull/1 for me'),
      prompt('review https://github.com/a/b/pull/2 for me'),
    ]);
    expect(readAsks({ path: history, now: NOW })[0].n).toBe(2);
  });

  it('drops slash commands, because an ask you can name already has a skill', () => {
    write([prompt('/ts-pr-review something something'), prompt('a genuine free text ask here')]);
    const asks = readAsks({ path: history, now: NOW });
    expect(asks.map((a) => a.text)).toEqual(['a genuine free text ask here']);
  });

  it('drops shell lines, which are commands rather than requests', () => {
    write([prompt('! gcloud auth application-default login'), prompt('a genuine free text ask here')]);
    expect(readAsks({ path: history, now: NOW }).map((a) => a.text)).toEqual([
      'a genuine free text ask here',
    ]);
  });

  it('drops prompts that are turns rather than asks', () => {
    write([prompt('go'), prompt('yes please'), prompt('an ask long enough to mean something')]);
    expect(readAsks({ path: history, now: NOW })).toHaveLength(1);
  });

  it('ignores anything older than the window', () => {
    write([prompt('an ask from well before the window', { timestamp: NOW - 100 * DAY })]);
    expect(readAsks({ path: history, days: 90, now: NOW })).toHaveLength(0);
  });

  it('survives a truncated final line, which an append-only log will have', () => {
    writeFileSync(history, JSON.stringify(prompt('a perfectly good ask to keep')) + '\n{"display":"tru');
    expect(readAsks({ path: history, now: NOW })).toHaveLength(1);
  });

  it('is empty rather than throwing when there is no history file', () => {
    expect(readAsks({ path: join(root, 'nope.jsonl'), now: NOW })).toEqual([]);
  });

  it('sorts by how often the ask was repeated', () => {
    write([
      prompt('the ask asked once of them all'),
      prompt('the ask asked twice over'),
      prompt('the ask asked twice over'),
    ]);
    expect(readAsks({ path: history, now: NOW }).map((a) => a.n)).toEqual([2, 1]);
  });
});

describe('how far back a pass looks', () => {
  const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

  it('reads the whole backlog the first time, when nothing has been judged yet', () => {
    expect(windowDays({ days: 90, last: '', now: NOW })).toBe(90);
  });

  it('reads only since the last pass, plus a lookback', () => {
    expect(windowDays({ days: 90, last: iso(7), now: NOW })).toBe(37);
  });

  it('never opens wider than the configured window', () => {
    expect(windowDays({ days: 90, last: iso(400), now: NOW })).toBe(90);
  });

  it('keeps the lookback even when the last pass was minutes ago', () => {
    // Otherwise a second run on the same day would see nothing recur at all.
    expect(windowDays({ days: 90, last: new Date(NOW).toISOString(), now: NOW })).toBe(30);
  });

  it('falls back to the full window when the stamp is unreadable', () => {
    expect(windowDays({ days: 90, last: 'not a date', now: NOW })).toBe(90);
  });
});

describe('the weekly slot', () => {
  const sunday = new Date('2026-08-09T10:00:00'); // a Sunday, after 09:00 local

  it('reads "off" as no schedule at all', () => {
    expect(parseCadence('off')).toBeNull();
    expect(passDue({ weekly: 'off', last: '', now: sunday })).toBe(false);
  });

  it('is due the first time it is ever asked', () => {
    expect(passDue({ weekly: 'SUN 09:00', last: '', now: sunday })).toBe(true);
  });

  it('is not due again once the pass has run for that slot', () => {
    const now = new Date('2026-08-09T23:00:00');
    expect(passDue({ weekly: 'SUN 09:00', last: '2026-08-09T09:30:00', now })).toBe(false);
  });

  it('catches up on a weekday when the slot was missed on the day', () => {
    // Nobody opened a terminal on Sunday. Wednesday still owes the pass.
    const wednesday = new Date('2026-08-12T08:00:00');
    expect(passDue({ weekly: 'SUN 09:00', last: '2026-08-02T09:30:00', now: wednesday })).toBe(true);
  });

  it('does not fire before the slot has come round for the first time', () => {
    const saturday = new Date('2026-08-08T20:00:00');
    expect(passDue({ weekly: 'SUN 09:00', last: '2026-08-02T09:30:00', now: saturday })).toBe(false);
  });

  it('treats an unparseable cadence as no schedule, never as every session', () => {
    expect(passDue({ weekly: 'whenever', last: '', now: sunday })).toBe(false);
    expect(passDue({ weekly: 'SUN 25:00', last: '', now: sunday })).toBe(false);
  });
});

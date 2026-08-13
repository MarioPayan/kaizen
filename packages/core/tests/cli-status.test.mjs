/**
 * The session line, end to end through the real CLI.
 *
 * Lives in @kaizen/core rather than a workspace of its own because this is the
 * only .mjs vitest harness in the repo, and `npm test` runs `--workspaces` — a
 * test file outside one would simply never execute. A `scripts` workspace with
 * its own config is more machinery than the two branches it would cover.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSurface } from '../src/taxonomy.mjs';

const cli = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'scripts', 'cli.mjs');

let root;

const run = (config) => {
  const path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify(config));
  return execFileSync('node', [cli, 'status'], {
    encoding: 'utf8',
    env: { ...process.env, KAIZEN_CONFIG: path },
  });
};

const base = (over = {}) => ({
  targets: [{ name: 'user', skills: join(root, 'skills'), feedback: join(root, 'feedback') }],
  cadence: { weekly: 'SUN 09:00', sessionHook: true },
  ...over,
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kaizen-status-'));
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  mkdirSync(join(root, 'feedback', 'demo'), { recursive: true });
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n\n# Demo\n');
  writeFileSync(
    join(root, 'feedback', 'demo', '2026-01-01-a-thing.md'),
    [
      '---',
      'skill: demo',
      'date: 2026-01-01',
      'severity: low',
      '---',
      '',
      '## Suggestion',
      '',
      'do it',
      '',
    ].join('\n'),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('kaizen status', () => {
  it('reports what is waiting', () => {
    expect(run(base())).toMatch(/kaizen: 1 untriaged/);
  });

  it('says nothing at all when the session line is switched off', () => {
    // The Settings toggle was written, typed and rendered for months with no
    // reader. This is the test that keeps it connected to something.
    expect(run(base({ cadence: { weekly: 'SUN 09:00', sessionHook: false } }))).toBe('');
  });

  it('counts only what the surface preference asks for', () => {
    // The one suggestion on disk is untriaged, so it survives any allow-list —
    // that is the rule. Marking it triaged and below the floor removes it.
    writeFileSync(
      join(root, 'feedback', 'demo', '2026-01-01-a-thing.md'),
      [
        '---',
        'skill: demo',
        'date: 2026-01-01',
        'severity: low',
        'effort: S',
        'type: content',
        'objective: clarity',
        'rung: 2',
        'status: planned',
        '---',
        '',
        '## Suggestion',
        '',
        'do it',
        '',
      ].join('\n'),
    );
    expect(run(base())).toMatch(/1 awaiting you/);
    expect(run(base({ surface: { ...defaultSurface(), minSeverity: 'high' } }))).toBe('');
  });

  /**
   * "Awaiting you" has to mean it is actually waiting on Mario.
   *
   * It used to count `approved` as well, which waits on the server — that is how
   * the line came to announce 39 items that needed nothing from anyone, every
   * session, for weeks. The pile at the door of the attended phase is `planned`,
   * and it is derived from the spec rather than listed here.
   */
  it('does not count a decision that is waiting on the server', () => {
    const file = join(root, 'feedback', 'demo', '2026-01-01-a-thing.md');
    const approved = readFileSync(file, 'utf8').replace('status: planned', 'status: approved');
    writeFileSync(file, approved);
    const out = run(base());
    expect(out).not.toMatch(/awaiting you/);
  });

  /**
   * `top:` has to name work, not history. A promoted cluster whose members are
   * all applied or superseded is fully addressed — and one of exactly that shape
   * was headlining every session with 27 incidents nobody could act on.
   */
  it('names a top cluster only while some of it is still open', () => {
    mkdirSync(join(root, 'feedback', 'demo2'), { recursive: true });
    const member = (slug, status) =>
      writeFileSync(
        join(root, 'feedback', 'demo2', `2026-01-02-${slug}.md`),
        [
          '---',
          'skill: demo2',
          'date: 2026-01-02',
          'severity: low',
          'cluster: pinned-pair',
          `status: ${status}`,
          '---',
          '',
          '## Suggestion',
          '',
          // Vocabulary the demo file above does not share — otherwise its
          // still-open member drifts into this cluster and keeps `top:` honest.
          'normalise the remote before comparing',
          '',
          '## Recurrence — 2026-01-03',
          '',
          '## Recurrence — 2026-01-04',
          '',
        ].join('\n'),
      );

    // 3 incidents each → 6 ≥ 5: promoted. Both landed or terminal → silent.
    member('origin-first', 'applied');
    member('origin-second', 'superseded');
    expect(run(base())).not.toMatch(/top:/);

    // One member back in play → the cluster is work again.
    member('origin-first', 'recorded');
    expect(run(base())).toMatch(/top: pinned-pair/);
  });
});

/**
 * `--bar` is concept A of the status-bar proposals: pile shapes, ANSI color,
 * dim 改 when clear. Asserted on the glyph grammar with the color stripped.
 */
describe('kaizen status --bar', () => {
  const bar = (config) => {
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify(config));
    const out = execFileSync('node', [cli, 'status', '--bar'], {
      encoding: 'utf8',
      env: { ...process.env, KAIZEN_CONFIG: path },
    });
    // eslint-disable-next-line no-control-regex
    return { raw: out, plain: out.replace(/\x1b\[[0-9;]*m/g, '').trim() };
  };

  it('draws one dot per pile and points at the hottest open category', () => {
    // The corpus built up by the tests above: pinned-pair holds a recorded
    // member (3 incidents) plus superseded/approved siblings from demo.
    const { plain } = bar(base());
    expect(plain).toMatch(/^改 ○\d+/);
    expect(plain).toContain('▲');
  });

  it('is a dim 改 when there is nothing to say, and ignores the hook toggle', () => {
    const quiet = mkdtempSync(join(tmpdir(), 'kaizen-bar-'));
    mkdirSync(join(quiet, 'skills'), { recursive: true });
    mkdirSync(join(quiet, 'feedback'), { recursive: true });
    const { raw, plain } = bar({
      targets: [{ name: 'user', skills: join(quiet, 'skills'), feedback: join(quiet, 'feedback') }],
      cadence: { weekly: 'SUN 09:00', sessionHook: false },
    });
    expect(plain).toBe('改');
    expect(raw).toContain('\x1b[2m');
    rmSync(quiet, { recursive: true, force: true });
  });
});

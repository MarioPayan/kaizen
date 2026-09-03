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
    expect(run(base())).toMatch(/kaizen: 1 to triage/);
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
   * A plan opencode wrote is not yours until claude has checked it. The
   * status says `planned`; the flag says whose move it is, and the line reads
   * the flag — or it would greet you with a decision you cannot make yet.
   */
  it('does not count a plan still waiting on its check', () => {
    const file = join(root, 'feedback', 'demo', '2026-01-01-a-thing.md');
    const approved = readFileSync(file, 'utf8');
    writeFileSync(file, approved.replace('status: approved', 'status: planned\nneeds_review: claude'));
    expect(run(base())).not.toMatch(/awaiting you/);
    writeFileSync(file, approved.replace('status: approved', 'status: planned\nneeds_review:'));
    expect(run(base())).toMatch(/1 awaiting you/);
    writeFileSync(file, approved);
  });

  /**
   * `top:` has to name work, not history — and the number has to be the work,
   * not the history either. It counted every incident a skill had ever filed
   * while merely *gating* on one being open, so a skill 71 incidents of which
   * were closed headlined every session with all 94.
   */
  it('counts only open incidents when it names the top skill', () => {
    mkdirSync(join(root, 'feedback', 'demo2'), { recursive: true });
    const member = (slug, status) =>
      writeFileSync(
        join(root, 'feedback', 'demo2', `2026-01-02-${slug}.md`),
        [
          '---',
          'skill: demo2',
          'date: 2026-01-02',
          'severity: low',
          `status: ${status}`,
          '---',
          '',
          '## Suggestion',
          '',
          'normalise the remote before comparing',
          '',
          '## Recurrence — 2026-01-03',
          '',
          '## Recurrence — 2026-01-04',
          '',
          '## Recurrence — 2026-01-05',
          '',
          '## Recurrence — 2026-01-06',
          '',
        ].join('\n'),
      );

    // 5 incidents each. One landed, one closed: nothing here is still costing
    // anyone, however loud the history is.
    member('origin-first', 'applied');
    member('origin-second', 'superseded');
    expect(run(base())).not.toMatch(/top:/);

    // One member back in play → the skill is work again, and worth exactly its
    // own 5 incidents. The closed sibling's 5 do not join them.
    member('origin-first', 'recorded');
    expect(run(base())).toMatch(/top: demo2 \(5\)/);
  });

  /**
   * A card parked on a call only Mario can make is waiting on Mario, whatever
   * its status says. The board has drawn that flag since `blocked_on` landed;
   * the line went on reporting those cards as nothing at all.
   */
  it('counts a card parked on you, and stops the moment it closes', () => {
    const file = join(root, 'feedback', 'demo', '2026-01-01-a-thing.md');
    const parked = readFileSync(file, 'utf8').replace(
      'status: approved',
      'status: approved\nblocked_on: needs a call about the remote',
    );
    writeFileSync(file, parked);
    expect(run(base())).toMatch(/1 awaiting you/);

    // Closed is closed: the block is still written down, and it is history now.
    writeFileSync(file, parked.replace('status: approved', 'status: superseded'));
    expect(run(base())).not.toMatch(/awaiting you/);
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

  it('draws one dot per pile and points at the hottest open skill', () => {
    // The corpus built up by the tests above: demo2 holds a recorded member
    // worth 5 incidents plus a superseded sibling worth 5 more. The bar counts
    // the same piles the line does, so the sibling's five are not in the ▲.
    const { plain } = bar(base());
    expect(plain).toMatch(/^改 ○\d+/);
    expect(plain).toContain('▲5');
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

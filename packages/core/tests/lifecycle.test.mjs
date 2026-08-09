/**
 * The spec, and the promise that it is the only copy.
 *
 * Two different things are under test. The validator has to reject a spec that
 * reads fine and describes a machine that cannot run — a transition to a status
 * nobody defined, a state nothing can reach. And the checked-in artifacts have
 * to still match what the spec generates, because "single source" is a claim
 * about a file on disk, not about intent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import {
  loadLifecycle,
  validateLifecycle,
  renderMarkdown,
  renderTypes,
  LIFECYCLE_PATH,
  section,
  missingRequirements,
} from '../src/lifecycle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const spec = () => loadLifecycle();

/** A minimal spec that passes, so each case below can break exactly one thing. */
const ok = () => ({
  phases: [
    {
      id: 'one',
      title: 'One',
      actor: 'a',
      produces: 'start',
      attended: false,
      summary: 's',
      requires: ['f'],
    },
    { id: 'two', title: 'Two', actor: 'b', produces: 'done', attended: true, summary: 's', requires: [] },
  ],
  statuses: [
    {
      id: 'start',
      label: 'Start',
      abbrev: 'sta',
      phase: 'one',
      tone: 'accent',
      terminal: false,
      aliases: ['old'],
      help: 'h',
      next: ['done'],
    },
    {
      id: 'done',
      label: 'Done',
      abbrev: 'don',
      phase: 'two',
      tone: 'positive',
      terminal: true,
      aliases: [],
      help: 'h',
      next: [],
    },
  ],
  fields: [{ id: 'f', phase: 'one', where: 'frontmatter', help: 'h' }],
});

describe('the shipped spec', () => {
  it('is coherent', () => {
    expect(validateLifecycle(spec())).toEqual([]);
  });

  it('has exactly one attended phase', () => {
    // More than one and it stops being a pipeline you can leave running.
    expect(spec().phases.filter((p) => p.attended)).toHaveLength(1);
  });

  it('makes approval reachable only from a planned state', () => {
    // The whole reason the spec exists: 39 suggestions once sat at `approved`
    // with no patch behind any of them.
    const into = spec()
      .statuses.filter((s) => s.next.includes('approved'))
      .map((s) => s.id);
    expect(into).toEqual(['planned']);
  });

  it('can reach a terminal state from every live one', () => {
    const { statuses } = spec();
    const byId = new Map(statuses.map((s) => [s.id, s]));
    for (const start of statuses) {
      const seen = new Set([start.id]);
      const queue = [start.id];
      let reachedTerminal = false;
      while (queue.length) {
        const cur = byId.get(queue.shift());
        if (cur.terminal) reachedTerminal = true;
        for (const n of cur.next) if (!seen.has(n)) (seen.add(n), queue.push(n));
      }
      expect(reachedTerminal, `${start.id} cannot reach a terminal state`).toBe(true);
    }
  });
});

describe('validateLifecycle', () => {
  const errorsFor = (mutate) => {
    const l = ok();
    mutate(l);
    return validateLifecycle(l);
  };

  it('accepts the minimal valid spec', () => {
    expect(validateLifecycle(ok())).toEqual([]);
  });

  it('rejects a transition to a status that does not exist', () => {
    expect(errorsFor((l) => l.statuses[0].next.push('ghost'))).toContainEqual(
      expect.stringContaining('next "ghost" does not exist'),
    );
  });

  it('rejects a status that transitions to itself', () => {
    expect(errorsFor((l) => l.statuses[0].next.push('start'))).toContainEqual(
      expect.stringContaining('transitions to itself'),
    );
  });

  it('rejects an abbreviation that is not three wide', () => {
    expect(errorsFor((l) => (l.statuses[0].abbrev = 'ab'))).toContainEqual(
      expect.stringContaining('exactly 3 characters'),
    );
  });

  it('rejects a duplicate abbreviation', () => {
    // Two statuses drawing the same three letters is indistinguishable in the
    // one column the queue actually has room for.
    expect(errorsFor((l) => (l.statuses[1].abbrev = 'sta'))).toContainEqual(
      expect.stringContaining('already used by'),
    );
  });

  it('rejects terminal disagreeing with next, in both directions', () => {
    expect(errorsFor((l) => (l.statuses[1].next = ['start']))).toContainEqual(
      expect.stringContaining('terminal but has next'),
    );
    expect(errorsFor((l) => (l.statuses[0].next = []))).toContainEqual(
      expect.stringContaining('nowhere to go'),
    );
  });

  it('rejects an alias that collides with a status id', () => {
    expect(errorsFor((l) => l.statuses[0].aliases.push('done'))).toContainEqual(
      expect.stringContaining('collides with a status id'),
    );
  });

  it('rejects an unreachable status', () => {
    expect(
      errorsFor((l) => {
        l.statuses[0].next = [];
        l.statuses[0].terminal = true;
      }),
    ).toContainEqual(expect.stringContaining('unreachable'));
  });

  it('rejects a phase producing a status nobody defined', () => {
    expect(errorsFor((l) => (l.phases[0].produces = 'ghost'))).toContainEqual(
      expect.stringContaining('produces "ghost" does not exist'),
    );
  });

  it('rejects a phase requiring a field nobody defined', () => {
    expect(errorsFor((l) => l.phases[0].requires.push('ghost'))).toContainEqual(
      expect.stringContaining('requires unknown field "ghost"'),
    );
  });

  it('rejects a status or field naming a phase that does not exist', () => {
    expect(errorsFor((l) => (l.statuses[0].phase = 'ghost'))).toContainEqual(
      expect.stringContaining('phase "ghost" does not exist'),
    );
    expect(errorsFor((l) => (l.fields[0].phase = 'ghost'))).toContainEqual(
      expect.stringContaining('phase "ghost" does not exist'),
    );
  });
});

describe('section', () => {
  /**
   * The regression that matters. The previous parser ended its lookahead with
   * `\Z`, a Perl anchor JavaScript does not have — it compiled to a literal `Z`,
   * so a section with no `##` after it never matched. Rationale is the last
   * heading in almost every suggestion, and 34 of 73 files on disk were reading
   * as having none.
   */
  it('reads a section that is the last thing in the file', () => {
    const body = '## Context\n\nc\n\n## Why it matters\n\nbecause it costs a retry\n';
    expect(section(body, 'Why it matters')).toBe('because it costs a retry');
  });

  it('reads a section with another heading after it', () => {
    const body = '## Why it matters\n\nbecause\n\n## Recurrence — 2026-01-01\n\nx\n';
    expect(section(body, 'Why it matters')).toBe('because');
  });

  it('stops at the next heading rather than swallowing it', () => {
    const body = '## Plan\n\ndo x\n\n## Validation\n\nrun y\n';
    expect(section(body, 'Plan')).toBe('do x');
    expect(section(body, 'Validation')).toBe('run y');
  });

  it('is blank for a heading that is absent or empty', () => {
    expect(section('## Plan\n\n## Validation\n\ny\n', 'Plan')).toBe('');
    expect(section('nothing here', 'Plan')).toBe('');
    expect(section('', 'Plan')).toBe('');
  });

  it('matches the heading case-insensitively but not by prefix', () => {
    expect(section('## plan\n\nx\n', 'Plan')).toBe('x');
    expect(section('## Planning\n\nx\n', 'Plan')).toBe('');
  });
});

describe('missingRequirements', () => {
  const body = '## Plan\n\ndo x\n\n## Validation\n\nrun y\n';

  it('names every field the target phase demands and the file lacks', () => {
    expect(missingRequirements('planned', { data: {}, body: '', hasPatch: false })).toEqual([
      'plan',
      'validation',
      'patch',
    ]);
  });

  it('is satisfied when all three are there', () => {
    expect(missingRequirements('planned', { data: {}, body, hasPatch: true })).toEqual([]);
  });

  it('treats an empty heading as missing, not as present', () => {
    const placeholder = '## Plan\n\n## Validation\n\nrun y\n';
    expect(missingRequirements('planned', { data: {}, body: placeholder, hasPatch: true })).toEqual(['plan']);
  });

  it('checks frontmatter fields for the phases that use them', () => {
    const missing = missingRequirements('triaged', { data: { type: 'bug' }, body: '' });
    expect(missing).toContain('confirmed_at');
    expect(missing).toContain('scope');
    expect(missing).not.toContain('type');
  });

  it('asks nothing of a status whose phase requires nothing', () => {
    expect(missingRequirements('approved', { data: {}, body: '' })).toEqual([]);
  });

  it('accepts a legacy status name', () => {
    expect(missingRequirements('proposed', { data: {}, body, hasPatch: true })).toEqual([]);
  });
});

describe('the generated artifacts', () => {
  // A generator whose output moves on its own turns `docs --check` into noise
  // people learn to skip, so determinism is the property worth pinning.
  it('render identically for identical input', () => {
    expect(renderMarkdown(spec())).toBe(renderMarkdown(spec()));
    expect(renderTypes(spec())).toBe(renderTypes(spec()));
  });

  it('keep the JSON out of the generated module comment field', () => {
    expect(renderTypes(spec())).not.toContain('$comment');
  });

  it('derive the union from the statuses rather than widening to string', () => {
    const ts = renderTypes(spec());
    expect(ts).toContain('as const');
    expect(ts).toContain('export type LifecycleStatus = (typeof LIFECYCLE.statuses)[number]["id"];');
  });

  it('state the approval invariant as derived, not asserted', () => {
    expect(renderMarkdown(spec())).toContain('`approved` is reachable only from `planned`');
  });

  it.each([
    ['docs/LIFECYCLE.md', renderMarkdown, 'markdown'],
    ['packages/data/src/lifecycle.generated.ts', renderTypes, 'typescript'],
  ])('%s on disk matches what the spec generates', async (rel, render, parser) => {
    const path = join(ROOT, rel);
    // Same resolveConfig dance as the generator: without it this asserts against
    // prettier's defaults and disagrees with what `kaizen docs` actually wrote.
    const options = (await prettier.resolveConfig(path)) ?? {};
    const expected = await prettier.format(render(spec()), { ...options, parser, filepath: path });
    expect(readFileSync(path, 'utf8'), `${rel} is stale — run: node scripts/cli.mjs docs`).toBe(expected);
  });

  it('reads the spec from the repo root', () => {
    expect(LIFECYCLE_PATH).toBe(join(ROOT, 'lifecycle.json'));
  });
});

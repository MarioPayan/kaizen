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
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import {
  writeSection,
  loadLifecycle,
  validateLifecycle,
  renderMarkdown,
  LIFECYCLE_PATH,
  section,
  missingRequirements,
  nextPhase,
  runnerOf,
  awaitsPass,
  pendingPass,
  awaitingDecision,
} from '../src/lifecycle.mjs';
import { patchIdentity } from '../src/suggestion.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const spec = () => loadLifecycle();

/** A minimal spec that passes, so each case below can break exactly one thing. */
const ok = () => ({
  phases: [
    {
      id: 'one',
      title: 'One',
      actor: 'a',
      runner: 'a',
      produces: 'start',
      attended: false,
      summary: 's',
      requires: ['f'],
    },
    {
      id: 'two',
      title: 'Two',
      actor: 'b',
      runner: 'you',
      produces: 'done',
      attended: true,
      summary: 's',
      requires: [],
    },
  ],
  statuses: [
    {
      id: 'start',
      label: 'Start',
      abbrev: 'sta',
      phase: 'one',
      tone: 'accent',
      terminal: false,
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

  /**
   * A status can go back now — a check that fails sends the card to the pile
   * it came from — and the phase a status *moves into* has to stay the forward
   * one. Capture produces `recorded` and sits first in the file, so "first
   * phase whose product is reachable" would send every triaged card there.
   */
  it('reads the next phase in next order, so a back-edge never becomes the way forward', () => {
    expect(nextPhase('recorded').id).toBe('triage');
    expect(nextPhase('triaged').id).toBe('plan');
    expect(nextPhase('planned').id).toBe('decide');
    expect(nextPhase('approved').id).toBe('apply');
    expect(nextPhase('applied').id).toBe('review');
    expect(nextPhase('reviewed').id).toBe('verify');
    expect(nextPhase('failed').id).toBe('plan');
    expect(nextPhase('verified')).toBeNull();
  });

  /**
   * Whose move it is falls out of the spec, and a card wearing `needs_review`
   * is the reviewer's whatever its status says — that is the whole difference
   * between a plan you can approve and one nobody has checked yet.
   */
  it('names the runner from the phase, or the reviewer from the flag', () => {
    const card = (status, needsReview = '', blockedOn = '') => ({ status, needsReview, blockedOn });
    expect(runnerOf(card('recorded'))).toBe('opencode');
    expect(runnerOf(card('triaged'))).toBe('opencode');
    expect(runnerOf(card('planned'))).toBe('you');
    expect(runnerOf(card('approved'))).toBe('server');
    expect(runnerOf(card('applied'))).toBe('opencode');
    expect(runnerOf(card('reviewed'))).toBe('claude');
    expect(runnerOf(card('planned', 'claude'))).toBe('claude');
    expect(runnerOf(card('verified'))).toBe('');

    // The dispatch gate: a model's move, and not parked.
    for (const s of ['recorded', 'triaged', 'failed', 'applied', 'reviewed']) {
      expect(awaitsPass(s), s).toBe(true);
      expect(pendingPass(card(s)), s).toBe(true);
    }
    for (const s of ['planned', 'approved', 'verified', 'rejected']) expect(awaitsPass(s), s).toBe(false);
    expect(pendingPass(card('planned', 'claude'))).toBe(true);
    expect(pendingPass(card('triaged', '', 'waiting on a call'))).toBe(false);
    expect(pendingPass(card('planned', 'claude', 'waiting on a call'))).toBe(false);
    // The pile at the door of the decision is still one status; what the
    // callers subtract from it is the flag.
    expect(awaitingDecision()).toEqual(['planned']);
  });

  /**
   * A yes is given to a specific patch. When that patch no longer lands the
   * plan is redone and the decision re-made — so approved can go back to
   * planned — while the way forward and the way out stay what they were.
   */
  it('lets an approval go back for a new plan without changing where it goes otherwise', () => {
    const { statuses } = spec();
    expect(statuses.find((s) => s.id === 'approved').next).toEqual([
      'applied',
      'planned',
      'triaged',
      'superseded',
    ]);
    expect(nextPhase('approved').id).toBe('apply');
    expect(spec().fields.find((f) => f.id === 'answer')).toMatchObject({ where: 'body', heading: 'Answer' });
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

  it('rejects an unreachable status', () => {
    expect(
      errorsFor((l) => {
        l.statuses[0].next = [];
        l.statuses[0].terminal = true;
      }),
    ).toContainEqual(expect.stringContaining('unreachable'));
  });

  it('rejects a phase with no runner, and a reviewer that is not a name', () => {
    expect(errorsFor((l) => delete l.phases[0].runner)).toContain('phase "one": needs a runner');
    expect(errorsFor((l) => (l.phases[0].reviewer = ''))).toContain(
      'phase "one": reviewer must be a name, or absent',
    );
    expect(errorsFor((l) => (l.phases[0].reviewer = 'b'))).toEqual([]);
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

  /**
   * The rung number is written into every triaged suggestion on disk, so its
   * position in this list *is* its meaning. A gap or a reorder would silently
   * relabel the whole corpus.
   */
  it('rejects rungs that are not 0..n in order', () => {
    const withRungs = (rungs) => {
      const l = ok();
      l.rungs = rungs;
      return validateLifecycle(l);
    };
    const good = [
      { n: 0, title: 't', detail: 'd', cost: 'c' },
      { n: 1, title: 't', detail: 'd', cost: 'c' },
    ];
    expect(withRungs(good)).toEqual([]);
    expect(withRungs([good[1], good[0]])).toContainEqual(expect.stringContaining('no gaps'));
    expect(withRungs([good[0], { n: 2, title: 't', detail: 'd', cost: 'c' }])).toContainEqual(
      expect.stringContaining('no gaps'),
    );
    expect(withRungs([{ n: 0, title: 't' }])).toContainEqual(
      expect.stringContaining('needs title, detail and cost'),
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

describe('writeSection', () => {
  it('replaces a present section in place and appends an absent one, leaving the frontmatter alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kaizen-section-'));
    const file = join(dir, 'card.md');
    writeFileSync(file, '---\nstatus: triaged\n---\n\n## Context\n\nc\n\n## Verdict\n\nold\n');
    writeSection(file, 'Verdict', 'new');
    writeSection(file, 'Answer', 'said');
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('---\nstatus: triaged\n---\n')).toBe(true);
    expect(section(text, 'Verdict')).toBe('new');
    expect(section(text, 'Answer')).toBe('said');
    expect(section(text, 'Context')).toBe('c');
    expect(text.match(/^## Verdict/gm)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
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

  it('requires the identity of the patch that was approved', () => {
    expect(missingRequirements('approved', { data: {}, body: '' })).toEqual(['approved_patch']);
    expect(missingRequirements('approved', { data: { approved_patch: 'sha256:x' }, body: '' })).toEqual([]);
  });

  it('asks nothing of a status the spec does not know', () => {
    // There is one spelling per status now, so an unknown name is a typo rather
    // than an older word for the same thing.
    expect(missingRequirements('proposed', { data: {}, body: '', hasPatch: false })).toEqual([]);
  });
});

describe('patchIdentity', () => {
  it('is stable for identical bytes and changes with the patch', () => {
    expect(patchIdentity(Buffer.from('a'))).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(patchIdentity(Buffer.from('a'))).toBe(patchIdentity(Buffer.from('a')));
    expect(patchIdentity(Buffer.from('a'))).not.toBe(patchIdentity(Buffer.from('b')));
  });
});

describe('the generated artifacts', () => {
  // A generator whose output moves on its own turns `docs --check` into noise
  // people learn to skip, so determinism is the property worth pinning.
  it('render identically for identical input', () => {
    expect(renderMarkdown(spec())).toBe(renderMarkdown(spec()));
  });

  it('render the determinism ladder, which used to live in the web app', () => {
    const md = renderMarkdown(spec());
    expect(md).toContain('## The determinism ladder');
    for (const r of spec().rungs) expect(md).toContain(r.title);
  });

  it('state the approval invariant as derived, not asserted', () => {
    expect(renderMarkdown(spec())).toContain('`approved` is reachable only from `planned`');
  });

  it('explain the check flag from the phases that name a reviewer', () => {
    const md = renderMarkdown(spec());
    expect(md).toContain('| Checked by |');
    expect(md).toContain('`needs_review: claude`');
    // Derived: a spec with no reviewers says nothing about a flag nobody sets.
    const unchecked = { ...spec(), phases: spec().phases.map(({ reviewer: _r, ...p }) => p) };
    expect(renderMarkdown(unchecked)).not.toContain('is provisional');
  });

  it.each([['docs/LIFECYCLE.md', renderMarkdown, 'markdown']])(
    '%s on disk matches what the spec generates',
    async (rel, render, parser) => {
      const path = join(ROOT, rel);
      // Same resolveConfig dance as the generator: without it this asserts against
      // prettier's defaults and disagrees with what `kaizen docs` actually wrote.
      const options = (await prettier.resolveConfig(path)) ?? {};
      const expected = await prettier.format(render(spec()), { ...options, parser, filepath: path });
      expect(readFileSync(path, 'utf8'), `${rel} is stale — run: node scripts/cli.mjs docs`).toBe(expected);
    },
  );

  it('reads the spec from the repo root', () => {
    expect(LIFECYCLE_PATH).toBe(join(ROOT, 'lifecycle.json'));
  });
});

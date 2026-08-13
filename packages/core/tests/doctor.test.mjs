/**
 * The self-review, reviewed.
 *
 * Each case here is a defect that was found by hand during a real pass. The
 * point of the check is that the next one is found by the machine, so the test
 * that matters most is the negative one: a healthy queue must produce silence,
 * or the report becomes noise nobody reads.
 */
import { describe, it, expect } from 'vitest';
import { runDoctor, findingToMarkdown, CHECKS } from '../src/doctor.mjs';
import { defaultConfig } from '../src/config.mjs';

const TODAY = '2026-08-08';

const suggestion = (over = {}) => ({
  id: 'user/demo/2026-08-01-a.md',
  file: '/tmp/does-not-exist/2026-08-01-a.md',
  skill: 'demo',
  slug: 'a-thing',
  date: '2026-08-01',
  status: 'recorded',
  scope: 'demo/SKILL.md',
  severity: 'low',
  ...over,
});

const stateWith = (suggestions) => ({ suggestions, skills: [], metrics: {} });

// A config with no targets keeps the script-scanning check off the real machine,
// so these assertions are about the checks and not about this laptop's contents.
const config = { ...defaultConfig(), targets: [] };
const run = (state) => runDoctor({ config, state, today: TODAY });
const only = (state, id) => run(state).filter((f) => f.check === id);

describe('kaizen doctor', () => {
  it('says nothing about a healthy queue', () => {
    // Different scopes: sharing one would read as a shared-scope fix orphaning
    // its sibling, which is a different test below.
    const healthy = stateWith([suggestion(), suggestion({ status: 'applied', scope: 'other/file.md' })]);
    // dead-config-key greps the real repo and may legitimately fire; every other
    // check must be silent, or a clean run still produces a wall of text.
    const noisy = run(healthy).filter((f) => f.check !== 'dead-config-key');
    expect(noisy).toEqual([]);
  });

  /**
   * The shape of this session's 27. A shared-scope fix closes one suggestion
   * and the drain marks only the one named in its commit trailer, so the rest
   * sit at their old status reading as open work — for months, in the real
   * case, while the code that fixed them had long shipped.
   */
  describe('scope-fix-orphans-siblings', () => {
    it('flags the unfinished siblings when one has already landed', () => {
      const found = only(
        stateWith([
          suggestion({ id: 'user/demo/a.md', slug: 'a', status: 'applied', appliedSha: 'c9168b6dead' }),
          suggestion({ id: 'user/demo/b.md', slug: 'b', status: 'recorded' }),
          suggestion({ id: 'user/demo/c.md', slug: 'c', status: 'approved' }),
        ]),
        'scope-fix-orphans-siblings',
      );
      expect(found).toHaveLength(1);
      expect(found[0].context).toMatch(/1 of 3 suggestions are finished, 2 are not/);
      expect(found[0].context).toMatch(/\bb\b/);
      // Naming the commit is what makes the re-check cheap.
      expect(found[0].suggestion).toMatch(/c9168b6/);
    });

    it('counts superseded as finished, since that is how a sibling gets closed', () => {
      const found = only(
        stateWith([
          suggestion({ id: 'user/demo/a.md', slug: 'a', status: 'superseded' }),
          suggestion({ id: 'user/demo/b.md', slug: 'b', status: 'triaged' }),
        ]),
        'scope-fix-orphans-siblings',
      );
      expect(found).toHaveLength(1);
    });

    it('says nothing while the whole scope is still open', () => {
      const found = only(
        stateWith([
          suggestion({ id: 'user/demo/a.md', slug: 'a', status: 'recorded' }),
          suggestion({ id: 'user/demo/b.md', slug: 'b', status: 'recorded' }),
        ]),
        'scope-fix-orphans-siblings',
      );
      expect(found).toEqual([]);
    });

    it('says nothing when the whole scope is finished', () => {
      const found = only(
        stateWith([
          suggestion({ id: 'user/demo/a.md', slug: 'a', status: 'applied' }),
          suggestion({ id: 'user/demo/b.md', slug: 'b', status: 'verified' }),
        ]),
        'scope-fix-orphans-siblings',
      );
      expect(found).toEqual([]);
    });

    /**
     * Suggestions that merely share a skill or vocabulary are not siblings —
     * each may need its own fix. Only an identical scope path means one
     * artefact closes them all.
     */
    it('ignores suggestions that do not share one scope', () => {
      const found = only(
        stateWith([
          suggestion({ id: 'user/demo/a.md', slug: 'a', status: 'applied', scope: 'one/a.sh' }),
          suggestion({ id: 'user/demo/b.md', slug: 'b', status: 'recorded', scope: 'two/b.sh' }),
        ]),
        'scope-fix-orphans-siblings',
      );
      expect(found).toEqual([]);
    });
  });

  it('flags a decision with no patch behind it', () => {
    const found = only(stateWith([suggestion({ status: 'approved' })]), 'decided-without-a-patch');
    expect(found).toHaveLength(1);
    expect(found[0].context).toMatch(/1 suggestion\(s\) sit at planned or approved/);
  });

  it('does not flag a decision that has one', () => {
    // The patch is looked for beside the .md; this file genuinely exists.
    const withPatch = suggestion({ status: 'approved', file: new URL(import.meta.url).pathname });
    expect(only(stateWith([withPatch]), 'decided-without-a-patch')).toEqual([]);
  });

  it('flags decisions that have sat past the drain window', () => {
    const old = suggestion({ status: 'planned', date: '2026-01-01' });
    expect(only(stateWith([old]), 'stale-decision')).toHaveLength(1);
    const fresh = suggestion({ status: 'planned', date: '2026-08-07' });
    expect(only(stateWith([fresh]), 'stale-decision')).toEqual([]);
  });

  it('measures capture quality and stays quiet when it is good', () => {
    // The failure this exists for: 100% of suggestions arriving with no scope.
    const bad = stateWith(Array.from({ length: 10 }, () => suggestion({ scope: '' })));
    const found = only(bad, 'capture-quality');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('high');
    expect(found[0].scope).toBe('skills/_lib/skill-reflect.md');

    // One missing out of ten is under the threshold — a rate, not a hunt.
    const mostlyGood = stateWith([
      suggestion({ scope: '' }),
      ...Array.from({ length: 9 }, () => suggestion()),
    ]);
    expect(only(mostlyGood, 'capture-quality')).toEqual([]);
  });

  it('produces findings shaped exactly like suggestions', () => {
    const [f] = only(stateWith([suggestion({ status: 'approved' })]), 'decided-without-a-patch');
    const md = findingToMarkdown(f, TODAY);
    // Every field the parser needs, or the finding lands untriaged and scores 0
    // — which would bury the tool's own report at the bottom of its own queue.
    for (const key of [
      'skill',
      'date',
      'severity',
      'scope',
      'status',
      'type',
      'objective',
      'rung',
      'effort',
    ]) {
      expect(md).toMatch(new RegExp(`^${key}: .+$`, 'm'));
    }
    expect(md).toContain('## Context');
    expect(md).toContain('## Suggestion');
  });

  it('does not call a landed patch rotten', () => {
    // The first run after a drain reported every applied patch as broken —
    // of course it no longer applies, it is already in. A self-review that
    // cries wolf after a successful pass is worse than no self-review.
    const landed = suggestion({ status: 'applied', file: new URL(import.meta.url).pathname });
    expect(only(stateWith([landed]), 'patch-no-longer-applies')).toEqual([]);
  });

  it('every check has a stable id', () => {
    const ids = CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The id goes into the filed slug, so renaming one re-files everything.
    expect(ids).toContain('capture-quality');
  });
});

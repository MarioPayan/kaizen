/**
 * The self-review, reviewed.
 *
 * Each case here is a defect that was found by hand during a real pass. The
 * point of the check is that the next one is found by the machine, so the test
 * that matters most is the negative one: a healthy queue must produce silence,
 * or the report becomes noise nobody reads.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDoctor, findingToMarkdown, CHECKS } from '../src/doctor.mjs';
import { defaultConfig } from '../src/config.mjs';
import { missingRequirements } from '../src/lifecycle.mjs';

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
      // c is approved — mid-pipeline, not "unmarked" — so only b is reported.
      expect(found[0].context).toMatch(/1 of 3 suggestions are finished, 1 sit pre-plan/);
      expect(found[0].context).toMatch(/\bb\b/);
      expect(found[0].context).not.toMatch(/\bc\b/);
      // Naming the commit is what makes the re-check cheap.
      expect(found[0].suggestion).toMatch(/c9168b6/);
    });

    /**
     * The false positive of the 2026-08-13 pass: the only unfinished sibling
     * was a live proposal awaiting a decision, and the check still called it
     * probably-fixed-and-unmarked. A member in the patch window is visibly
     * open; the premise only holds for members the pipeline has not reached.
     */
    it('says nothing when every open member is already planned or approved', () => {
      const found = only(
        stateWith([
          suggestion({ id: 'user/demo/a.md', slug: 'a', status: 'applied', appliedSha: 'c9168b6dead' }),
          suggestion({ id: 'user/demo/b.md', slug: 'b', status: 'planned' }),
          suggestion({ id: 'user/demo/c.md', slug: 'c', status: 'approved' }),
        ]),
        'scope-fix-orphans-siblings',
      );
      expect(found).toEqual([]);
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

    /**
     * The false positives of the 2026-08-16 pass: three findings, each naming
     * one pre-plan member that had been filed two days *after* the scope's fix
     * landed. A suggestion written after the commit cannot be an orphan of it.
     * With no target to resolve the sha in, the fix date falls back to the
     * finished sibling's own filing date, which is what these fixtures exercise.
     */
    it("says nothing about a member filed after the scope's last fix", () => {
      const found = only(
        stateWith([
          suggestion({ id: 'user/demo/a.md', slug: 'a', status: 'applied', date: '2026-08-01' }),
          suggestion({ id: 'user/demo/b.md', slug: 'b', status: 'triaged', date: '2026-08-05' }),
        ]),
        'scope-fix-orphans-siblings',
      );
      expect(found).toEqual([]);
    });

    it('still flags a member filed before a later, sha-less fix', () => {
      const found = only(
        stateWith([
          suggestion({ id: 'user/demo/a.md', slug: 'a', status: 'superseded', date: '2026-08-10' }),
          suggestion({ id: 'user/demo/b.md', slug: 'b', status: 'triaged', date: '2026-08-01' }),
          // Filed after the fix: not an orphan, and not in the count.
          suggestion({ id: 'user/demo/c.md', slug: 'c', status: 'triaged', date: '2026-08-12' }),
        ]),
        'scope-fix-orphans-siblings',
      );
      expect(found).toHaveLength(1);
      expect(found[0].context).toMatch(/1 of 3 suggestions are finished, 1 sit pre-plan/);
      expect(found[0].context).toMatch(/\bb\b/);
      expect(found[0].context).not.toMatch(/\bc\b/);
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

  /**
   * Doctor's own filings must pass the capture spec kaizen enforces on everyone
   * else — `validate` reported every one of them as "recorded is missing
   * evidence" the day they were written, so `--strict` could never be adopted.
   * One state fires every state-driven check; each finding, rendered, owes the
   * spec nothing.
   */
  it('files findings that satisfy the capture phase, evidence included', () => {
    const here = new URL(import.meta.url).pathname;
    const state = stateWith([
      // decided-without-a-patch, stale-decision (filed long before TODAY)
      suggestion({ id: 'user/demo/2026-01-01-old.md', slug: 'old', status: 'approved', date: '2026-01-01' }),
      // scope-fix-orphans-siblings: a landed member and a pre-plan one
      suggestion({
        id: 'user/demo/2026-08-01-done.md',
        slug: 'done',
        status: 'applied',
        scope: 'x/SKILL.md',
      }),
      suggestion({
        id: 'user/demo/2026-07-01-open.md',
        slug: 'open',
        status: 'triaged',
        scope: 'x/SKILL.md',
        date: '2026-07-01',
      }),
      // harness-scope-rung-mismatch
      suggestion({
        id: 'user/demo/2026-08-01-h.md',
        slug: 'h',
        scope: '_lib/claude-md-guardrails.md',
        rung: 2,
      }),
      // scope-has-several-live-patches: two live siblings, each with a sidecar
      suggestion({
        id: 'user/demo/2026-08-01-p1.md',
        slug: 'p1',
        status: 'planned',
        scope: 'y/SKILL.md',
        file: here,
      }),
      suggestion({
        id: 'user/demo/2026-08-01-p2.md',
        slug: 'p2',
        status: 'planned',
        scope: 'y/SKILL.md',
        file: here,
      }),
      // capture-quality: enough scopeless rows to cross the threshold
      ...[1, 2, 3].map((n) => suggestion({ id: `user/demo/2026-08-01-s${n}.md`, slug: `s${n}`, scope: '' })),
    ]);
    const findings = run(state).filter((f) => f.check !== 'dead-config-key');
    const fired = new Set(findings.map((f) => f.check));
    for (const id of [
      'decided-without-a-patch',
      'stale-decision',
      'scope-fix-orphans-siblings',
      'harness-scope-rung-mismatch',
      'scope-has-several-live-patches',
      'capture-quality',
    ]) {
      expect(fired, `fixture fires ${id}`).toContain(id);
    }
    for (const f of findings) {
      const body = findingToMarkdown(f, TODAY);
      expect(body, f.check).toContain('## Evidence');
      expect(missingRequirements('recorded', { data: f, body, hasPatch: false }), f.check).toEqual([]);
    }
  });

  it('does not call a landed patch rotten', () => {
    // The first run after a drain reported every applied patch as broken —
    // of course it no longer applies, it is already in. A self-review that
    // cries wolf after a successful pass is worse than no self-review.
    const landed = suggestion({ status: 'applied', file: new URL(import.meta.url).pathname });
    expect(only(stateWith([landed]), 'patch-no-longer-applies')).toEqual([]);
  });

  /**
   * A project skill files into the user feedback dir — that is where
   * skill-reflect puts it — but its patch is against the project. Checked at
   * the target's skills tree it always reads as rotten (2026-08-16 pass, one
   * medium false positive per doctor run). The scan already knows the skill's
   * project; the check has to look there.
   */
  it("checks a project skill's patch in its project, not at the target", () => {
    const root = mkdtempSync(join(tmpdir(), 'kaizen-doctor-project-'));
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    const repo = (name, files) => {
      const dir = join(root, name);
      mkdirSync(dir);
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 'k@example.com');
      git(dir, 'config', 'user.name', 'k');
      for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'init');
      return dir;
    };
    // The patch touches a file only the project has; the target's tree lacks it.
    const project = repo('project', { 'SKILL.md': 'one\n' });
    const target = repo('target', { 'other.md': 'x\n' });
    writeFileSync(join(project, 'SKILL.md'), 'one\ntwo\n');
    const patchText = String(git(project, 'diff'));
    git(project, 'checkout', '--', 'SKILL.md');
    const feedback = join(root, 'feedback');
    mkdirSync(feedback);
    writeFileSync(join(feedback, 'a.md'), '');
    writeFileSync(join(feedback, 'a.patch'), patchText);

    const cfg = { ...defaultConfig(), targets: [{ name: 'user', skills: target }] };
    const planned = suggestion({ status: 'planned', file: join(feedback, 'a.md'), target: 'user' });
    const findings = (skills) =>
      runDoctor({ config: cfg, state: { suggestions: [planned], skills, metrics: {} }, today: TODAY }).filter(
        (f) => f.check === 'patch-no-longer-applies',
      );

    // Unknown skill: checked at the target, where it genuinely does not apply.
    expect(findings([])).toHaveLength(1);
    // Known project skill: checked in its project, where it applies fine.
    expect(findings([{ name: 'demo', project }])).toEqual([]);
    // Known but missing project: unknowable, not rotten.
    expect(findings([{ name: 'demo', project: join(root, 'gone') }])).toEqual([]);
  });

  /**
   * Found at plan time, by hand: a suggestion scoped to the guardrails file
   * and labelled rung 2, when the ladder and the file's own header both say a
   * CLAUDE.md line is rung 0. A wrong label outranks a blank one in the queue.
   */
  describe('harness-scope-rung-mismatch', () => {
    it('flags a harness-scoped suggestion labelled above rung 0', () => {
      const found = only(
        stateWith([suggestion({ scope: '_lib/claude-md-guardrails.md', rung: 2 })]),
        'harness-scope-rung-mismatch',
      );
      expect(found).toHaveLength(1);
      expect(found[0].context).toContain('rung 2');
    });

    it('is silent at rung 0, when untriaged, and off harness files', () => {
      const quiet = stateWith([
        suggestion({ scope: '_lib/claude-md-guardrails.md', rung: 0 }),
        suggestion({ scope: '~/.claude/CLAUDE.md', rung: null }),
        suggestion({ scope: 'demo/SKILL.md', rung: 2 }),
        // History is not relabelled.
        suggestion({ scope: 'settings.json', rung: 2, status: 'verified' }),
      ]);
      expect(only(quiet, 'harness-scope-rung-mismatch')).toEqual([]);
    });
  });

  /**
   * Two live patches on one scope: the cascade that closes a scope's siblings
   * on apply would stamp the second one superseded with a diff that never
   * landed. Seen on the guardrails scope, where the second patch also stopped
   * applying the moment the first lengthened the file.
   */
  describe('scope-has-several-live-patches', () => {
    // The sidecar is looked for by swapping .md for .patch; this .mjs file
    // survives the swap and genuinely exists, the same trick the patch checks use.
    const here = new URL(import.meta.url).pathname;
    const withPatch = (over) => suggestion({ file: here, ...over });

    it('flags a scope where two planned/approved siblings each carry a patch', () => {
      const found = only(
        stateWith([
          withPatch({ id: 'user/demo/a.md', slug: 'a', status: 'approved' }),
          withPatch({ id: 'user/demo/b.md', slug: 'b', status: 'planned' }),
        ]),
        'scope-has-several-live-patches',
      );
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('medium');
      expect(found[0].context).toContain('a@approved');
      expect(found[0].context).toContain('b@planned');
    });

    it('is silent for one patch per scope, patch-less members, and other targets', () => {
      const quiet = stateWith([
        withPatch({ id: 'user/demo/a.md', slug: 'a', status: 'approved' }),
        // The intended shape: a member covered by the lead's patch, none of its own.
        suggestion({ id: 'user/demo/b.md', slug: 'b', status: 'planned' }),
        // Same scope path in another target is another file.
        withPatch({ id: 'other/demo/c.md', slug: 'c', status: 'planned', target: 'other' }),
        // A landed one is history, not a live proposal.
        withPatch({ id: 'user/demo/d.md', slug: 'd', status: 'applied' }),
      ]);
      expect(only(quiet, 'scope-has-several-live-patches')).toEqual([]);
    });
  });

  it('every check has a stable id', () => {
    const ids = CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The id goes into the filed slug, so renaming one re-files everything.
    expect(ids).toContain('capture-quality');
  });
});

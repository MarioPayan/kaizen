import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignBlockedBy, buildState, patchFor } from '../src/scan.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('patchFor', () => {
  it('resolves a dated carrier name before an ambiguous short slug', () => {
    const cards = [
      {
        id: 'user/demo/2026-01-01-lead.md',
        file: '/tmp/2026-01-01-lead.md',
        slug: 'lead',
        status: 'planned',
      },
      {
        id: 'user/demo/2026-01-02-lead.md',
        file: '/tmp/2026-01-02-lead.md',
        slug: 'lead',
        status: 'planned',
      },
      {
        id: 'user/demo/2026-01-03-member.md',
        file: '/tmp/2026-01-03-member.md',
        slug: 'member',
        status: 'triaged',
        blockedOn: 'carried by 2026-01-02-lead',
      },
    ];
    assignBlockedBy(cards);
    expect(cards[2].blockedBy).toBe(cards[1].id);
  });

  it('uses only its own patch or the live carrier it explicitly names', () => {
    const root = mkdtempSync(join(tmpdir(), 'kaizen-carrier-patch-'));
    roots.push(root);
    const file = (slug) => join(root, `${slug}.md`);
    const row = (slug, over = {}) => ({
      id: `user/demo/${slug}.md`,
      file: file(slug),
      target: 'user',
      status: 'planned',
      blockedBy: '',
      ...over,
    });
    writeFileSync(file('lead').replace(/\.md$/, '.patch'), 'lead');
    writeFileSync(file('own').replace(/\.md$/, '.patch'), 'own');

    const lead = row('lead');
    expect(patchFor(row('own', { blockedBy: lead.id }), [lead])).toBe(file('own').replace(/\.md$/, '.patch'));
    expect(patchFor(row('member', { blockedBy: lead.id }), [lead])).toBe(
      file('lead').replace(/\.md$/, '.patch'),
    );
    expect(patchFor(row('stranger'), [lead])).toBeNull();
    expect(patchFor(row('member', { blockedBy: lead.id }), [{ ...lead, status: 'applied' }])).toBeNull();
  });

  it('stamps a carried member with its lead patch without lending by scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'kaizen-carrier-state-'));
    roots.push(root);
    const feedbackRoot = join(root, 'feedback');
    const feedback = join(feedbackRoot, 'demo');
    mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
    mkdirSync(feedback, { recursive: true });
    writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n');
    const card = (slug, extra = '') =>
      writeFileSync(
        join(feedback, `${slug}.md`),
        `---\nskill: demo\ndate: 2026-01-01\nstatus: ${slug.includes('lead') ? 'planned' : 'triaged'}\nscope: demo/SKILL.md\n${extra}---\n\n## Suggestion\n\ns\n`,
      );
    card('2026-01-01-lead');
    card('2026-01-02-member', 'blocked_on: carried by 2026-01-01-lead\n');
    card('2026-01-03-stranger');
    const leadPatch = join(feedback, '2026-01-01-lead.patch');
    writeFileSync(leadPatch, 'diff');

    const state = buildState({
      targets: [{ name: 'user', skills: join(root, 'skills'), feedback: feedbackRoot }],
    });
    const bySlug = Object.fromEntries(state.suggestions.map((s) => [s.slug, s]));
    expect(bySlug.lead.patch).toBe(leadPatch);
    expect(bySlug.member.patch).toBe(leadPatch);
    expect(bySlug.stranger.patch).toBeNull();
  });
});

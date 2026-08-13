import { describe, it, expect } from 'vitest';
import { parseFrontmatter, parseSuggestion, score, splitFilename } from '../src/suggestion.mjs';
import { categorize } from '../src/categories.mjs';

const suggestion = ({ slug, body = '', ...fm }) => {
  const front = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return parseSuggestion({
    id: `t/skill/2026-01-01-${slug}.md`,
    file: `2026-01-01-${slug}.md`,
    skill: 'skill',
    target: 't',
    text: `---\n${front}\n---\n\n## Context\n\n${body}\n\n## Suggestion\n\n${body}\n`,
  });
};

describe('frontmatter', () => {
  it('parses flat keys and strips quotes', () => {
    const { data, body } = parseFrontmatter('---\nskill: a\ntitle: "b c"\n---\nbody here');
    expect(data).toEqual({ skill: 'a', title: 'b c' });
    expect(body).toBe('body here');
  });

  it('treats an empty value as absent rather than crashing', () => {
    // A real file in the wild ships `severity:` with nothing after it.
    const { data } = parseFrontmatter('---\nseverity:\nskill: x\n---\n');
    expect(data.severity).toBe('');
    expect(data.skill).toBe('x');
  });

  it('returns the whole text when there is no frontmatter', () => {
    expect(parseFrontmatter('# just markdown').body).toBe('# just markdown');
  });

  it('splits date and slug out of a filename', () => {
    expect(splitFilename('/x/2026-07-29-verify-claimed.md')).toEqual({
      date: '2026-07-29',
      slug: 'verify-claimed',
    });
  });
});

describe('scoring', () => {
  it('multiplies impact by incidents and divides by effort', () => {
    expect(score({ severity: 'medium', effort: 'S', recurrences: 6 })).toBe(21);
    expect(score({ severity: 'high', effort: 'L', recurrences: 0 })).toBe(1);
  });

  it('scores untriaged items zero so they never outrank an assessed one', () => {
    expect(score({ severity: '', effort: 'S', recurrences: 9 })).toBe(0);
    expect(score({ severity: 'high', effort: '', recurrences: 9 })).toBe(0);
  });

  it('counts each recurrence section as another incident', () => {
    const s = parseSuggestion({
      id: 'a/b/c.md',
      file: 'c.md',
      skill: 'b',
      target: 'a',
      text: '---\nseverity: medium\neffort: S\n---\n## Suggestion\nx\n## Recurrence — 2026-01-01\ny\n## Recurrence — 2026-02-01\nz\n',
    });
    expect(s.recurrences).toBe(2);
    expect(s.incidents).toBe(3);
    expect(s.score).toBe(9);
  });

  it('reports missing taxonomy instead of inventing it', () => {
    const s = suggestion({ slug: 'x', severity: 'low' });
    expect(s.triaged).toBe(false);
    expect(s.missing).toContain('type');
    expect(s.type).toBe('');
  });
});

describe('categories', () => {
  it('groups by scope, because the category is where the fix lands', () => {
    const items = [
      suggestion({ slug: 'push-remote-not-always-origin', scope: '_lib/pr/local-workspace.md' }),
      suggestion({ slug: 'find-local-clone-checks-only-origin', scope: '_lib/pr/local-workspace.md' }),
      suggestion({ slug: 'ci-watch-times-out', scope: '_lib/pr/ci-settle.sh' }),
    ];
    const cats = categorize(items);
    expect(cats).toHaveLength(2);
    expect(cats[0].id).toBe('_lib/pr/local-workspace.md');
    expect(cats[0].size).toBe(2);
  });

  it('falls back to the skill for a suggestion with no scope yet', () => {
    const cats = categorize([suggestion({ slug: 'vague-thing' })]);
    expect(cats).toHaveLength(1);
    expect(cats[0].id).toBe('skill:skill');
  });

  it('honours an explicit pin over the scope key, old and new spelling alike', () => {
    const items = [
      suggestion({ slug: 'alpha-one', category: 'manual', scope: 'a.md' }),
      suggestion({ slug: 'beta-two', cluster: 'manual', scope: 'b.md' }),
    ];
    const cats = categorize(items);
    expect(cats).toHaveLength(1);
    expect(cats[0].id).toBe('manual');
    expect(cats[0].pinned).toBe(true);
  });

  it('keeps differently-pinned suggestions apart however alike their scope', () => {
    const items = [
      suggestion({ slug: 'left-one', category: 'left', scope: 'same.md' }),
      suggestion({ slug: 'right-one', category: 'right', scope: 'same.md' }),
    ];
    expect(categorize(items)).toHaveLength(2);
  });

  it('promotes a category once it crosses the members or incidents threshold', () => {
    const items = [
      suggestion({ slug: 'a-first', scope: 'x.md' }),
      suggestion({ slug: 'a-second', scope: 'x.md' }),
      suggestion({ slug: 'a-third', scope: 'x.md' }),
    ];
    const [cat] = categorize(items, { promotion: { members: 3, incidents: 5 } });
    expect(cat.size).toBe(3);
    expect(cat.promoted).toBe(true);
  });

  it('is deterministic: same corpus, same categories, worst first', () => {
    const items = [
      suggestion({ slug: 'quiet-one', scope: 'quiet.md' }),
      suggestion({ slug: 'busy-one', scope: 'busy.md', severity: 'high', effort: 'S' }),
      suggestion({ slug: 'busy-two', scope: 'busy.md', severity: 'high', effort: 'S' }),
    ];
    const a = categorize(items).map((c) => c.id);
    const b = categorize(items).map((c) => c.id);
    expect(a).toEqual(b);
    expect(a[0]).toBe('busy.md');
  });

  it('returns nothing for an empty corpus', () => {
    expect(categorize([])).toEqual([]);
  });
});

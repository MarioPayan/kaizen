import { describe, it, expect } from 'vitest';
import { parseFrontmatter, parseSuggestion, score, splitFilename } from '../src/suggestion.mjs';

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

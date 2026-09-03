import { describe, it, expect } from 'vitest';
import {
  ageOf,
  assignUids,
  parseFrontmatter,
  parseSuggestion,
  score,
  splitFilename,
} from '../src/suggestion.mjs';

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

describe('uid', () => {
  it('is three letters of the name, initials first, unique across the corpus, oldest keeps its pick', () => {
    const older = { ...suggestion({ slug: 'freshness-check-read-as-correctness' }), date: '2026-01-01' };
    const newer = { ...suggestion({ slug: 'fast-cheap-reliable' }), date: '2026-02-01' };
    const short = { ...suggestion({ slug: 'a-thing' }), date: '2026-03-01' };
    assignUids([newer, short, older]);
    expect(older.uid).toBe('FCR');
    expect(newer.uid).toBe(
      'FAS',
      'FCR is taken by the older card; three initials offer nothing else, so letters of the name',
    );
    expect(short.uid).toBe('ATH', 'two words fall through to letters of the whole name');
    // Deterministic: the same corpus, in any order, gives the same handles.
    const again = [{ ...older }, { ...newer }, { ...short }];
    assignUids(again);
    expect(again.map((s) => s.uid)).toEqual(['FCR', 'FAS', 'ATH']);
    // A name that cannot yield a free handle still gets a stable one.
    const tiny = { ...suggestion({ slug: 'ab' }), date: '2026-04-01' };
    assignUids([tiny]);
    expect(tiny.uid).toMatch(/^[0-9A-F]{3}$/);
  });
});

describe('age', () => {
  it('buckets a date into today, this week, this month or older, by rolling windows', () => {
    const today = '2026-08-15';
    expect(ageOf('2026-08-15', today)).toBe('today');
    expect(ageOf('2026-08-14', today)).toBe('this week');
    expect(ageOf('2026-08-09', today)).toBe('this week');
    expect(ageOf('2026-08-08', today)).toBe('this month');
    expect(ageOf('2026-07-17', today)).toBe('this month');
    expect(ageOf('2026-07-16', today)).toBe('older');
    // The future is not older than today — a clock skew files as today.
    expect(ageOf('2026-08-16', today)).toBe('today');
    // Undated cannot be recent.
    expect(ageOf('', today)).toBe('older');
    expect(ageOf('yesterday', today)).toBe('older');
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

  it('carries blocked_on through as data, and its absence as empty', () => {
    const parked = suggestion({ slug: 'parked-thing', blocked_on: 'where should this live?' });
    expect(parked.blockedOn).toBe('where should this live?');
    expect(suggestion({ slug: 'free-thing' }).blockedOn).toBe('');
  });

  it('carries needs_review through as data — who has to check the status before it counts', () => {
    const flagged = suggestion({ slug: 'flagged-thing', needs_review: 'claude' });
    expect(flagged.needsReview).toBe('claude');
    expect(suggestion({ slug: 'settled-thing' }).needsReview).toBe('');
  });

  it('carries confirmed_at through as data, so a pass can judge the stamp without opening the file', () => {
    const stamped = suggestion({ slug: 'checked-thing', confirmed_at: '2026-08-17 @ abc1234' });
    expect(stamped.confirmedAt).toBe('2026-08-17 @ abc1234');
    expect(suggestion({ slug: 'unchecked-thing' }).confirmedAt).toBe('');
  });
});

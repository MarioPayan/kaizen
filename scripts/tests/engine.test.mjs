import { describe, it, expect } from 'vitest';
import { parseFrontmatter, parseSuggestion, score, splitFilename } from '../lib/suggestion.mjs';
import { clusterSuggestions, termFrequencies } from '../lib/cluster.mjs';

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

describe('clustering', () => {
  it('groups suggestions that share rare vocabulary', () => {
    const items = [
      suggestion({
        slug: 'push-remote-not-always-origin',
        body: 'the git remote is not named origin, resolve the remote name',
      }),
      suggestion({
        slug: 'find-local-clone-checks-only-origin',
        body: 'validate the clone against any remote matching owner repo, not origin',
      }),
      suggestion({
        slug: 'standup-posts-at-wrong-hour',
        body: 'the slackbot reminder fires earlier than the constant says',
      }),
    ];
    const clusters = clusterSuggestions(items);
    const withRemote = clusters.find((c) => c.size > 1);
    expect(withRemote.size).toBe(2);
    expect(clusters).toHaveLength(2);
  });

  it('does not chain unrelated groups through one weak link', () => {
    // Single linkage merged these on the real corpus; average linkage must not.
    const items = [
      suggestion({
        slug: 'ci-watch-hangs',
        body: 'the ci watch loop hangs on a pending external status check',
      }),
      suggestion({
        slug: 'ci-watch-absent',
        body: 'ci watch concludes checks are absent before they register',
      }),
      suggestion({
        slug: 'finding-severity-out-of-diff',
        body: 'a finding outside the diff takes severity relative to this change set',
      }),
      suggestion({
        slug: 'duplicate-open-finding',
        body: 'a finding duplicating another reviewer open finding should not post',
      }),
    ];
    const clusters = clusterSuggestions(items);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.size === 2)).toBe(true);
  });

  it('honours an explicit pin over computed similarity', () => {
    const items = [
      suggestion({ slug: 'alpha-one', cluster: 'manual', body: 'entirely unrelated words about breakfast' }),
      suggestion({
        slug: 'beta-two',
        cluster: 'manual',
        body: 'nothing whatsoever in common with the above',
      }),
    ];
    const clusters = clusterSuggestions(items);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].id).toBe('manual');
    expect(clusters[0].pinned).toBe(true);
  });

  it('keeps differently-pinned suggestions apart however alike they read', () => {
    const items = [
      suggestion({
        slug: 'remote-origin-resolve',
        cluster: 'left',
        body: 'resolve the git remote origin name',
      }),
      suggestion({
        slug: 'remote-origin-resolve-two',
        cluster: 'right',
        body: 'resolve the git remote origin name',
      }),
    ];
    expect(clusterSuggestions(items)).toHaveLength(2);
  });

  it('promotes a cluster once it crosses the members or incidents threshold', () => {
    const body = 'the git remote origin name must be resolved from the repo remotes';
    const items = [
      suggestion({ slug: 'remote-origin-a', severity: 'medium', effort: 'S', body }),
      suggestion({ slug: 'remote-origin-b', severity: 'medium', effort: 'S', body }),
      suggestion({ slug: 'remote-origin-c', severity: 'medium', effort: 'S', body }),
    ];
    const [cluster] = clusterSuggestions(items, { promotion: { members: 3, incidents: 5 } });
    expect(cluster.size).toBe(3);
    expect(cluster.promoted).toBe(true);
  });

  it('weights slug words above body prose', () => {
    const tf = termFrequencies({ slug: 'origin', scope: '', context: 'origin', suggestion: '' });
    expect(tf.get('origin')).toBe(4); // 3 from the slug, 1 from the body
  });

  it('returns nothing for an empty corpus', () => {
    expect(clusterSuggestions([])).toEqual([]);
  });
});

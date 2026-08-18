/**
 * The `surface` preference: which suggestions get put in front of you.
 *
 * The case that matters most is the untriaged one. An allow-list over labels a
 * suggestion does not have yet would hide exactly the work that needs triage,
 * and the symptom — an untriaged count stuck at zero — looks like success.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSurface, surfaceOf, passesSurface } from '../src/taxonomy.mjs';
import { defaultConfig, validateConfig } from '../src/config.mjs';
import { buildState } from '../src/scan.mjs';

const triaged = (over = {}) => ({
  triaged: true,
  type: 'determinism',
  objective: 'bug',
  severity: 'medium',
  ...over,
});

describe('passesSurface', () => {
  it('always surfaces an untriaged suggestion, whatever the filter says', () => {
    const surface = { types: [], objectives: [], minSeverity: 'high' };
    const untriaged = { triaged: false, type: '', objective: '', severity: '' };
    expect(passesSurface(untriaged, surface)).toBe(true);
  });

  it('drops a suggestion below the minimum severity', () => {
    const surface = { ...defaultSurface(), minSeverity: 'high' };
    expect(passesSurface(triaged({ severity: 'medium' }), surface)).toBe(false);
    expect(passesSurface(triaged({ severity: 'high' }), surface)).toBe(true);
  });

  it('drops a type or objective outside the allow-list', () => {
    expect(passesSurface(triaged(), { ...defaultSurface(), types: ['hygiene'] })).toBe(false);
    expect(passesSurface(triaged(), { ...defaultSurface(), objectives: ['debt'] })).toBe(false);
  });
});

describe('surfaceOf', () => {
  // A config can reach the server without a `surface` block. Tolerating that is
  // what keeps every hand-written fixture in the other suites working.
  it('surfaces everything when the block is missing or partial', () => {
    for (const cfg of [undefined, {}, { surface: {} }, { surface: { minSeverity: 'nonsense' } }]) {
      expect(passesSurface(triaged({ severity: 'low' }), surfaceOf(cfg))).toBe(true);
    }
  });

  it('keeps the defaults for fields a partial block does not mention', () => {
    const surface = surfaceOf({ surface: { minSeverity: 'high' } });
    expect(surface.types).toEqual(defaultSurface().types);
    expect(surface.minSeverity).toBe('high');
  });
});

describe('validateConfig', () => {
  it('accepts the shipped default', () => {
    expect(validateConfig(defaultConfig())).toEqual([]);
  });

  it('rejects unknown values, an empty allow-list, and a bad severity', () => {
    const bad = (surface) => validateConfig({ ...defaultConfig(), surface });
    expect(bad({ ...defaultSurface(), types: ['nope'] })).toContain('surface.types: unknown value "nope"');
    expect(bad({ ...defaultSurface(), types: [] })).toContain('surface.types must be a non-empty array');
    expect(bad({ ...defaultSurface(), minSeverity: 'urgent' })).toHaveLength(1);
  });
});

describe('buildState', () => {
  let root;

  const file = (severity) =>
    [
      '---',
      'skill: demo',
      'date: 2026-01-01',
      `severity: ${severity}`,
      'effort: S',
      'type: determinism',
      'objective: bug',
      'rung: 1',
      '---',
      '',
      '## Suggestion',
      '',
      'do it',
      '',
    ].join('\n');

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'kaizen-surface-'));
    mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
    mkdirSync(join(root, 'feedback', 'demo'), { recursive: true });
    writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n\n# Demo\n');
    writeFileSync(join(root, 'feedback', 'demo', '2026-01-01-loud.md'), file('high'));
    writeFileSync(join(root, 'feedback', 'demo', '2026-01-02-quiet.md'), file('low'));
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /**
   * One field, two waits. A block naming another card still in play is that
   * card's to end; anything else is the user's, and the board draws them in
   * different places — so the distinction has to be data, not a reading of the
   * sentence.
   */
  it('tells a block that waits on another card from one that waits on you', () => {
    const parked = (name, blocked) =>
      writeFileSync(
        join(root, 'feedback', 'demo', `${name}.md`),
        file('low').replace('---\n\n## Suggestion', `blocked_on: ${blocked}\n---\n\n## Suggestion`),
      );
    parked('2026-02-01-carrier', 'nothing, it is the carrier');
    parked('2026-02-02-member', 'carried by 2026-02-01-carrier — supersede once it lands');
    parked('2026-02-03-yours', 'the target is read-only — make it writable or apply by hand');

    const state = buildState({
      targets: [{ name: 'user', skills: join(root, 'skills'), feedback: join(root, 'feedback') }],
    });
    const by = (slug) => state.suggestions.find((s) => s.slug === slug);
    expect(by('member').blockedBy).toBe('user/demo/2026-02-01-carrier.md');
    expect(by('yours').blockedBy).toBe('');
    expect(by('carrier').blockedBy).toBe('');
    // Every card with no block at all answers empty rather than undefined.
    expect(by('loud').blockedBy).toBe('');

    rmSync(join(root, 'feedback', 'demo', '2026-02-01-carrier.md'));
    rmSync(join(root, 'feedback', 'demo', '2026-02-02-member.md'));
    rmSync(join(root, 'feedback', 'demo', '2026-02-03-yours.md'));
  });

  it('tags each suggestion without dropping any', () => {
    const state = buildState({
      targets: [{ name: 'user', skills: join(root, 'skills'), feedback: join(root, 'feedback') }],
      surface: { ...defaultSurface(), minSeverity: 'high' },
    });

    // Both are still there and still counted — surface is a view preference, not
    // a filter on what exists.
    expect(state.suggestions).toHaveLength(2);
    expect(state.metrics.total).toBe(2);
    expect(state.suggestions.filter((s) => s.surfaced).map((s) => s.slug)).toEqual(['loud']);
  });
});

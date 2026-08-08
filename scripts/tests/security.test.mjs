/**
 * The API turns caller-supplied identifiers into file reads and writes, so these
 * are the checks that matter most. A failure here is not a wrong number on a
 * dashboard — it is reading or writing outside the directories the user chose.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertInside, isInside, parseSuggestionId, suggestionId } from '../lib/paths.mjs';
import { validateConfig, defaultConfig } from '../lib/config.mjs';

let root;
let allowed;
let outside;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kaizen-test-'));
  allowed = join(root, 'allowed');
  outside = join(root, 'outside');
  mkdirSync(allowed, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.md'), 'private');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('path containment', () => {
  it('accepts a file inside an allowed root', () => {
    const f = join(allowed, 'ok.md');
    writeFileSync(f, 'x');
    expect(assertInside([allowed], f)).toBe(assertInside([allowed], f));
  });

  it('refuses traversal out of the allowed root', () => {
    expect(() => assertInside([allowed], join(allowed, '..', 'outside', 'secret.md'))).toThrow(
      /outside every configured target/,
    );
  });

  it('refuses a symlink that escapes the allowed root', () => {
    // Comparing literal paths would pass this; resolving the link is the point.
    const link = join(allowed, 'escape.md');
    symlinkSync(join(outside, 'secret.md'), link);
    expect(() => assertInside([allowed], link)).toThrow(/outside every configured target/);
  });

  it('refuses a null byte in the path', () => {
    expect(() => assertInside([allowed], `${allowed}/x\0.md`)).toThrow(/null byte/);
  });

  it('treats the root itself as inside', () => {
    expect(isInside(allowed, allowed)).toBe(true);
    expect(isInside(allowed, outside)).toBe(false);
  });

  it('does not treat a sibling with a shared prefix as inside', () => {
    expect(isInside('/a/skills', '/a/skills-feedback/x.md')).toBe(false);
  });
});

describe('suggestion ids', () => {
  it('round-trips a well-formed id', () => {
    const id = suggestionId('user', 'ts-pr-review', '2026-07-03-thing.md');
    expect(parseSuggestionId(id)).toEqual({
      target: 'user',
      skill: 'ts-pr-review',
      file: '2026-07-03-thing.md',
    });
  });

  it.each([
    ['user/../etc/passwd.md', 'traversal segment'],
    ['user/skill/file.txt', 'wrong extension'],
    ['user/skill', 'too few segments'],
    ['user/skill/a/b.md', 'too many segments'],
    ['user/sk ill/f.md', 'space in segment'],
  ])('rejects %s (%s)', (id) => {
    expect(() => parseSuggestionId(id)).toThrow();
  });
});

describe('config validation', () => {
  it('accepts the shipped defaults', () => {
    expect(validateConfig(defaultConfig())).toEqual([]);
  });

  it('refuses to bind beyond loopback', () => {
    const cfg = defaultConfig();
    cfg.server.host = '0.0.0.0';
    // The loopback binding is the security boundary; exposing writes to the
    // network is not a preference the config is allowed to express.
    expect(validateConfig(cfg)).toContain('server.host must be 127.0.0.1');
  });

  it('rejects an unknown autoApply rule', () => {
    const cfg = defaultConfig();
    cfg.autoApply = ['everything:S'];
    expect(validateConfig(cfg).join()).toMatch(/unknown type/);
  });

  it('rejects scan enabled with no roots', () => {
    const cfg = defaultConfig();
    cfg.scan = { enabled: true, roots: [], depth: 3, writable: false };
    expect(validateConfig(cfg)).toContain('scan.enabled is true but scan.roots is empty');
  });

  it('requires both paths on every target', () => {
    const cfg = defaultConfig();
    cfg.targets = [{ name: 'a', skills: '/tmp/s' }];
    expect(validateConfig(cfg)).toContain('targets[0].feedback is required');
  });
});

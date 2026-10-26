/**
 * Rule retirement candidates: bullets in budgeted rule files whose origin has gone quiet.
 *
 * A bullet (`- `, `* `, `+ ` or `1. `) carries its origin as `<!-- origin: <slug> -->`; several
 * origins may be comma-separated, and each may be written as a slug, a dated file name or an id.
 * An origin is active when some suggestion, in any status, has a date or a dated recurrence within
 * the window (60 days by default) and either has that slug, or has a scope resolving to the rule
 * file and shares at least two content words with the origin slug. A bullet whose origins are all
 * inactive is listed as a candidate; a human decides whether to retire it.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expandPath } from './config.mjs';
import { contentWords } from './dedupe.mjs';
import { scopePath } from './scan.mjs';

const BULLET = /^\s*(?:[-*+]|\d+\.)\s/;
const ORIGIN = /<!--\s*origin:\s*(.*?)\s*-->/g;

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function markdownFiles(path) {
  try {
    if (statSync(path).isFile()) return [path];
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() || entry.name.endsWith('.md') ? markdownFiles(join(path, entry.name)) : [],
    );
  } catch {
    return [];
  }
}

export function originSlug(value) {
  const name = value.split('/').pop().replace(/\.md$/i, '');
  return name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

/** Bullets with origin comments in a file: `{ line, text, origins }`. */
export function originBullets(text) {
  const bullets = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!BULLET.test(line)) return;
    const origins = [...line.matchAll(ORIGIN)]
      .flatMap((match) => match[1].split(','))
      .map((origin) => originSlug(origin.trim()))
      .filter(Boolean);
    if (origins.length) bullets.push({ line: index + 1, text: line.trim(), origins });
  });
  return bullets;
}

export function retirementCandidates({ config, state, now = Date.now(), days = 60 }) {
  const cutoff = new Date(now - days * 86400000).toISOString().slice(0, 10);
  const targets = new Map(state.targets.map((target) => [target.name, target]));
  const recent = state.suggestions
    .filter((item) => [item.date, ...(item.recurrenceDates ?? [])].some((date) => date && date >= cutoff))
    .map((item) => {
      const target = targets.get(item.target);
      const path = target && item.scope ? scopePath(item, target) : '';
      return { item, path: path && existsSync(path) ? real(path) : path, words: contentWords(item.slug) };
    });
  const candidates = [];
  const files = new Set((config.budgets ?? []).flatMap((budget) => markdownFiles(expandPath(budget.path))));
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const realFile = real(file);
    for (const bullet of originBullets(text)) {
      const active = bullet.origins.some((origin) => {
        const words = contentWords(origin);
        return recent.some(
          ({ item, path, words: itemWords }) =>
            item.slug === origin ||
            (path === realFile && [...words].filter((word) => itemWords.has(word)).length >= 2),
        );
      });
      if (!active) candidates.push({ file, ...bullet });
    }
  }
  return candidates;
}

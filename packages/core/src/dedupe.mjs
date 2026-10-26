/**
 * Capture-time duplicate detection. Deterministic: exact scope comparison plus word overlap.
 *
 * Rules, first hit wins, applied to open items for `match`:
 *   1. same skill and the same normalized scope string;
 *   2. same skill and at least three shared dash-separated slug words;
 *   3. any skill or target: the same resolved scope file and at least three shared content words;
 *   4. any skill or target: at least three shared content words covering at least 60% of the
 *      shorter word set.
 * Content words come from the slug and the item's `# ` title, lowercased, without stopwords or
 * words shorter than three letters. Rules 2–4 are also applied to fixed items for `fixedMatch`:
 * a fixed item that matches is a problem that came back, which the capture records as a
 * `## Recurrence` on that file. Dropped items never match.
 */
import { normalizeScope, scopePath } from './scan.mjs';

const STOPWORDS = new Set(
  'the and for not but with from into onto than then that this when what why how its are was were has had does did dont doesnt cannot can will per via los las del por que con una para sin como'.split(
    ' ',
  ),
);

const dashWords = (slug) =>
  new Set(
    String(slug ?? '')
      .toLowerCase()
      .split('-')
      .filter(Boolean),
  );

export function contentWords(...texts) {
  const words = new Set();
  for (const text of texts)
    for (const word of String(text ?? '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u))
      if (word.length >= 3 && !STOPWORDS.has(word)) words.add(word);
  return words;
}

const shared = (a, b) => [...a].filter((word) => b.has(word)).sort();
const title = (item) => /^#\s+(.+)$/m.exec(item.body ?? '')?.[1] ?? '';
const skillOf = (item) => item.id?.split('/')[1] || item.skill;

function rules({ skill, scope, slug, targets }) {
  const byName = new Map(targets.map((target) => [target.name, target]));
  const incomingWords = contentWords(slug);
  const incomingDash = dashWords(slug);
  const incomingPaths = new Map();
  const incomingPath = (target) => {
    if (!incomingPaths.has(target.name))
      incomingPaths.set(target.name, scopePath({ scope: normalizeScope(scope, target.skills) }, target));
    return incomingPaths.get(target.name);
  };
  const words = (item) => shared(contentWords(item.slug, title(item)), incomingWords);
  return [
    (item) =>
      skillOf(item) === skill &&
      scope &&
      item.scope &&
      item.scope === normalizeScope(scope, byName.get(item.target)?.skills ?? '')
        ? `same normalized scope: ${item.scope}`
        : '',
    (item) => {
      if (skillOf(item) !== skill) return '';
      const common = shared(dashWords(item.slug), incomingDash);
      return common.length >= 3
        ? `slug shares ${common.length} dash-separated words: ${common.join(', ')}`
        : '';
    },
    (item) => {
      const target = byName.get(item.target);
      if (!scope || !item.scope || !target || scopePath(item, target) !== incomingPath(target)) return '';
      const common = words(item);
      return common.length >= 3
        ? `same scope file in ${skillOf(item)} and ${common.length} shared words: ${common.join(', ')}`
        : '';
    },
    (item) => {
      const common = words(item);
      const smaller = Math.min(incomingWords.size, contentWords(item.slug, title(item)).size);
      return common.length >= 3 && common.length / smaller >= 0.6
        ? `${skillOf(item)} shares ${common.length}/${smaller} words: ${common.join(', ')}`
        : '';
    },
  ];
}

/** `{ match, reason, fixedMatch?, fixedReason? }` for a capture about to be written. */
export function findDuplicate({ suggestions, skill, scope, slug, targets = [] }) {
  const tests = rules({ skill, scope, slug, targets });
  const first = (status, from) => {
    const pool = suggestions
      .filter((item) => item.status === status)
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const test of tests.slice(from))
      for (const item of pool) {
        const reason = test(item);
        if (reason) return { item, reason };
      }
    return null;
  };
  const open = first('open', 0);
  if (open) return { match: open.item.file, reason: open.reason };
  const result = {
    match: null,
    reason: `no open suggestion in any skill shares "${skill}"'s scope and words, or enough slug words`,
  };
  const fixed = first('fixed', 1);
  if (fixed) Object.assign(result, { fixedMatch: fixed.item.file, fixedReason: fixed.reason });
  return result;
}

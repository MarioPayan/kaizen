/**
 * Reading and scoring the suggestion files that skills file after each run.
 *
 * The on-disk format predates kaizen (see `_lib/skill-reflect.md`), so the parser
 * has to tolerate files written before the extra fields existed. Missing metadata
 * is reported, never invented — a suggestion with no `type` is untriaged, which is
 * a fact worth surfacing rather than a gap worth guessing at.
 */
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { TYPES, OBJECTIVES, EFFORTS, SEVERITIES } from './taxonomy.mjs';
import { canonicalStatus, statusIds, section } from './lifecycle.mjs';

/** Every status a file may name. There is one spelling per status. */
export const STATUSES = statusIds();

const IMPACT = { low: 1, medium: 3, high: 8 };
const EFFORT_COST = { S: 1, M: 3, L: 8 };

/**
 * Flat `key: value` frontmatter only — that is the whole format these files use.
 * Pulling in a YAML dependency to parse two dozen scalars would be more code to
 * audit than the parser itself.
 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text };

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if (value === '~' || value === 'null') value = '';
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return { data, body: match[2] };
}

/** `2026-05-21-push-remote-not-always-origin.md` → `2026-05-21`, `push-remote-…`. */
export function splitFilename(file) {
  const name = basename(file).replace(/\.md$/i, '');
  const m = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(name);
  return m ? { date: m[1], slug: m[2] } : { date: '', slug: name };
}

/**
 * The three-letter handles a name could wear, best first: three of its
 * initials in order (`freshness-check-read-as-correctness` → FCR, FCA, FRA…),
 * then any three of its letters in order (`a-thing` → ATH, ATI…). Letters of
 * the name, so the handle is readable *as* the name; in order, so it is never
 * an anagram of a different one.
 */
function* handles(slug) {
  const words = slug
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
  const three = function* (letters) {
    for (let i = 0; i < letters.length; i++)
      for (let j = i + 1; j < letters.length; j++)
        for (let k = j + 1; k < letters.length; k++) yield letters[i] + letters[j] + letters[k];
  };
  yield* three(words.map((w) => w[0]).join(''));
  yield* three(words.join(''));
}

/**
 * Give every suggestion a three-letter uid, unique across the corpus, made of
 * its own name. Assigned oldest-first so an arrival never takes a handle a
 * card already wears; a handle only ever changes when an *older* card that
 * held its first choice is removed. Nothing is stored — the corpus is the
 * registry — so a scan on another machine assigns the same handles.
 */
// ponytail: recomputed per scan, not written to the file; stamp `uid` in
// frontmatter if the churn on pruning ever bites.
export function assignUids(suggestions) {
  const taken = new Set();
  const order = [...suggestions].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const s of order) {
    let uid;
    for (const h of handles(s.slug || s.id)) {
      if (!taken.has(h)) {
        uid = h;
        break;
      }
    }
    // A name too short or too common to yield a free handle falls back to
    // the id's hash, which is at least stable.
    for (let n = 0; uid === undefined; n++) {
      const h = createHash('sha1').update(`${s.id}${n}`).digest('hex').slice(0, 3).toUpperCase();
      if (!taken.has(h)) uid = h;
    }
    taken.add(uid);
    s.uid = uid;
  }
  return suggestions;
}

/** Today as the files write it — `2026-08-15`, local time, not UTC's tomorrow. */
export function localToday(now = new Date()) {
  return now.toLocaleDateString('sv');
}

/**
 * How recent a suggestion is, in the four words a board groups by: `today`,
 * `this week`, `this month`, `older`. Rolling windows (7 and 30 days), not the
 * calendar's — "this week" on a Monday morning would otherwise be empty. Both
 * dates are `YYYY-MM-DD`; an undated or unparseable one is `older`, which is
 * where nothing recent can hide.
 */
export function ageOf(date, today = localToday()) {
  const day = (d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d ?? '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN;
  };
  const days = day(today) - day(date);
  if (Number.isNaN(days)) return 'older';
  if (days <= 0) return 'today';
  if (days < 7) return 'this week';
  if (days < 30) return 'this month';
  return 'older';
}

function captureSection(body, ...headings) {
  for (const heading of headings) {
    const value = section(body, heading);
    if (value) return value;
  }
  return '';
}

export function parseSuggestion({ id, file, skill, target, text }) {
  const { data, body } = parseFrontmatter(text);
  const fromName = splitFilename(file);

  // Each `## Recurrence — <date>` section is one more time this actually happened.
  const recurrences = (body.match(/^##\s+Recurrence/gim) ?? []).length;

  const severity = SEVERITIES.includes(data.severity) ? data.severity : '';
  const effort = EFFORTS.includes(data.effort) ? data.effort : '';
  const rung = /^[0-3]$/.test(data.rung ?? '') ? Number(data.rung) : null;

  const missing = [];
  if (!severity) missing.push('severity');
  if (!TYPES.includes(data.type)) missing.push('type');
  if (!OBJECTIVES.includes(data.objective)) missing.push('objective');
  if (!effort) missing.push('effort');
  if (rung === null) missing.push('rung');

  return {
    id,
    file,
    target,
    skill: data.skill || skill,
    date: data.date || fromName.date,
    slug: fromName.slug,
    severity,
    // An unrecognised status reads as the entry state rather than propagating
    // a typo through the queue.
    status: canonicalStatus(data.status) ?? 'recorded',
    type: TYPES.includes(data.type) ? data.type : '',
    objective: OBJECTIVES.includes(data.objective) ? data.objective : '',
    scope: data.scope || '',
    rung,
    effort,
    // One line of "why this sits where it sits" when a pass parks an item on a
    // decision only the user can make. Data, not log prose: twelve identical
    // triaged rows once hid that nine of them were waiting on three calls.
    blockedOn: data.blocked_on || '',
    // Who has to check the status before the card is where it says: the
    // runner writes the reviewer's name here beside every status it sets, and
    // the reviewer clears it. Empty means the status is settled.
    needsReview: data.needs_review || '',
    // Which commit the problem was last confirmed to still exist at. Step 3
    // says a confirmation is worth exactly as much as its commit; without this
    // in the scan, a targeted pass had to open the file to learn the stamp,
    // which is the read Step 2 exists to avoid.
    confirmedAt: data.confirmed_at || '',
    appliedSha: data.applied_sha || '',
    outcome: data.outcome || '',
    recurrences,
    incidents: 1 + recurrences,
    context: captureSection(body, 'Context', 'What ran'),
    suggestion: captureSection(body, 'Suggestion', 'Proposal'),
    rationale: captureSection(body, 'Why it matters', 'Why', 'What cost time'),
    // What the two reviews wrote, so the detail window can show a rejected
    // card's reason without opening the file — the block line is one sentence.
    review: section(body, 'Review'),
    verdict: section(body, 'Verdict'),
    // What the user said when a run parked the card on them — the other half
    // of the brief a card carries when it comes round again.
    answer: section(body, 'Answer'),
    missing,
    triaged: missing.length === 0,
    score: score({ severity, effort, recurrences }),
  };
}

/**
 * impact x (1 + recurrences) / effort.
 *
 * Recurrence is the honest signal — a suggestion filed six times is six real
 * incidents, not one loud opinion. Untriaged items score 0 so they sort below
 * anything that has actually been assessed rather than floating on a guess.
 */
export function score({ severity, effort, recurrences = 0 }) {
  const impact = IMPACT[severity];
  const cost = EFFORT_COST[effort];
  if (!impact || !cost) return 0;
  return Number(((impact * (1 + recurrences)) / cost).toFixed(2));
}

/**
 * Rewrite frontmatter keys in place, preserving key order and body.
 *
 * Lives here rather than in the CLI so the server can reuse it — importing a
 * module that parses argv and dispatches on import would run the CLI as a side
 * effect of asking for one function.
 */
export function writeFrontmatter(file, patch) {
  const text = readFileSync(file, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const body = m ? text.slice(m[0].length) : text;
  const lines = m ? m[1].split(/\r?\n/) : [];
  const seen = new Set();

  const out = lines.map((line) => {
    const sep = line.indexOf(':');
    if (sep === -1) return line;
    const key = line.slice(0, sep).trim();
    if (!(key in patch)) return line;
    seen.add(key);
    return `${key}: ${patch[key]}`;
  });
  for (const [k, v] of Object.entries(patch)) if (!seen.has(k)) out.push(`${k}: ${v}`);

  writeFileSync(file, `---\n${out.join('\n')}\n---\n${body.startsWith('\n') ? '' : '\n'}${body}`);
  return file;
}

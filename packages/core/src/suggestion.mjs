/**
 * Reading and scoring the suggestion files that skills file after each run.
 *
 * The on-disk format predates kaizen (see `_lib/skill-reflect.md`), so the parser
 * has to tolerate files written before the extra fields existed. Missing metadata
 * is reported, never invented — a suggestion with no `type` is untriaged, which is
 * a fact worth surfacing rather than a gap worth guessing at.
 */
import { basename } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { TYPES, OBJECTIVES, EFFORTS, SEVERITIES } from './taxonomy.mjs';
import { canonicalStatus, statusIds, acceptedStatuses, section } from './lifecycle.mjs';

/**
 * What a status may be *written as*, which includes the names used before the
 * lifecycle spec renamed them. Validation accepts these; everything downstream
 * sees the canonical id, because `parseSuggestion` resolves it on the way in.
 */
export const STATUSES = acceptedStatuses();

/** Just the canonical ids — what a writer should be choosing between. */
export const CANONICAL_STATUSES = statusIds();

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
    // Resolved here, once, so nothing above the parser has to know that `new`
    // and `recorded` are the same thing. An unrecognised status reads as the
    // entry state rather than propagating a typo through the queue.
    status: canonicalStatus(data.status) ?? 'recorded',
    type: TYPES.includes(data.type) ? data.type : '',
    objective: OBJECTIVES.includes(data.objective) ? data.objective : '',
    scope: data.scope || '',
    rung,
    effort,
    // A cluster pinned in frontmatter is a human decision and always wins over
    // whatever the automatic pass would have grouped this with.
    clusterPin: data.cluster || '',
    appliedSha: data.applied_sha || '',
    outcome: data.outcome || '',
    recurrences,
    incidents: 1 + recurrences,
    context: section(body, 'Context'),
    suggestion: section(body, 'Suggestion'),
    rationale: section(body, 'Why it matters'),
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

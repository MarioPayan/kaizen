import { basename } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

export const STATUSES = ['open', 'fixed', 'dropped'];
export const SEVERITIES = ['low', 'medium', 'high'];

export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value === '~' || value === 'null') value = '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    data[key] = value;
  }
  return { data, body: match[2] };
}

export function section(body, heading) {
  const lines = body.split(/\r?\n/);
  const wanted = heading.toLowerCase();
  const start = lines.findIndex((line) => /^##\s+(.*?)\s*$/.exec(line)?.[1].toLowerCase() === wanted);
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

function firstSection(body, ...headings) {
  for (const heading of headings) {
    const value = section(body, heading);
    if (value) return value;
  }
  return '';
}

export function splitFilename(file) {
  const name = basename(file).replace(/\.md$/i, '');
  const match = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(name);
  return match ? { date: match[1], slug: match[2] } : { date: '', slug: name };
}

export function canonicalStatus(value) {
  return STATUSES.includes(value) ? value : 'open';
}

export function isOpen(value) {
  return canonicalStatus(value) === 'open';
}

export function parseSuggestion({ id, file, skill, target, text }) {
  const { data, body } = parseFrontmatter(text);
  const named = splitFilename(file);
  const headings = [...body.matchAll(/^##\s+Recurrence\b([^\r\n]*)$/gim)];
  const recurrences = headings.length;
  // A recurrence is dated by the first YYYY-MM-DD on its heading line; undated ones carry no date.
  const recurrenceDates = headings.map((match) => /\d{4}-\d{2}-\d{2}/.exec(match[1])?.[0]).filter(Boolean);
  return {
    id,
    file,
    skill: data.skill || skill,
    target,
    scope: data.scope || '',
    severity: SEVERITIES.includes(data.severity) ? data.severity : '',
    status: canonicalStatus(data.status),
    rawStatus: data.status || '',
    date: data.date || named.date,
    slug: named.slug,
    recurrences,
    recurrenceDates,
    context: firstSection(body, 'Context', 'What ran'),
    suggestion: firstSection(body, 'Suggestion', 'Proposal'),
    evidence: section(body, 'Evidence'),
    verdict: section(body, 'Verdict'),
    answer: section(body, 'Answer'),
    appliedSha: data.applied_sha || '',
    closedAt: data.closed_at || '',
    verifiedAt: data.verified_at || '',
    fixedBy: data.fixed_by || '',
    droppedReason: data.dropped_reason || '',
    data,
    body,
  };
}

export function writeFrontmatter(file, patch) {
  const text = readFileSync(file, 'utf8');
  const parsed = parseFrontmatter(text);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const lines = match ? match[1].split(/\r?\n/) : [];
  const seen = new Set();
  const output = [];
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator < 0) {
      output.push(line);
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!(key in patch)) {
      output.push(line);
      continue;
    }
    seen.add(key);
    if (patch[key] !== null && patch[key] !== undefined) output.push(`${key}: ${patch[key]}`);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!seen.has(key) && value !== null && value !== undefined) output.push(`${key}: ${value}`);
  }
  const body = match ? text.slice(match[0].length) : parsed.body;
  writeFileSync(file, `---\n${output.join('\n')}\n---\n\n${body.replace(/^\r?\n+/, '')}`);
}

export function appendSection(file, heading, content) {
  let text = readFileSync(file, 'utf8').replace(/\s*$/, '');
  text += `\n\n## ${heading}\n\n${content.trim()}\n`;
  writeFileSync(file, text);
}

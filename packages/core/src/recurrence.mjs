/**
 * Recurred after fix: a `fixed` item whose problem came back.
 *
 * The fix date is the first of, in order:
 *   1. `closed_at` (the date part of the ISO timestamp `kaizen close` writes);
 *   2. the leading YYYY-MM-DD of `verified_at` (legacy lifecycle field);
 *   3. the committer date of `applied_sha` (else `fixed_by`, when it looks like a sha) in the
 *      git repository that owns the target's skills dir.
 * An item with no resolvable fix date is never flagged. A recurrence counts when the date on its
 * `## Recurrence` heading is strictly later than the fix date; undated recurrences are ignored,
 * and so is one on the fix day itself, because day granularity cannot order them.
 */
import { execFileSync } from 'node:child_process';
import { repoRoot } from './scan.mjs';

const DAY = /^(\d{4}-\d{2}-\d{2})/;
const SHA = /^[0-9a-f]{7,40}$/i;
const shaDates = new Map();

function commitDate(sha, dir) {
  const key = `${dir}\0${sha}`;
  if (!shaDates.has(key)) {
    let date = '';
    try {
      date = execFileSync('git', ['-C', repoRoot(dir), 'show', '-s', '--format=%cs', `${sha}^{commit}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Unknown sha or not a repository: the date stays unresolved.
    }
    shaDates.set(key, DAY.test(date) ? date : '');
  }
  return shaDates.get(key);
}

/** `{ date, source }` for a fixed item, or null when no rule resolves a date. */
export function fixDate(item, target) {
  const closed = DAY.exec(item.closedAt ?? '')?.[1];
  if (closed) return { date: closed, source: 'closed_at' };
  const verified = DAY.exec(item.verifiedAt ?? '')?.[1];
  if (verified) return { date: verified, source: 'verified_at' };
  const sha = [item.appliedSha, item.fixedBy].find((value) => SHA.test(value ?? ''));
  const committed = sha && target?.skills ? commitDate(sha, target.skills) : '';
  if (committed) return { date: committed, source: item.appliedSha === sha ? 'applied_sha' : 'fixed_by' };
  return null;
}

/** `{ fixedOn, source, dates }` when a fixed item has recurrences dated after its fix, else null. */
export function recurredAfterFix(item, target) {
  if (item.status !== 'fixed' || !item.recurrenceDates?.length) return null;
  const fixed = fixDate(item, target);
  if (!fixed) return null;
  const dates = item.recurrenceDates.filter((date) => date > fixed.date).sort();
  return dates.length ? { fixedOn: fixed.date, source: fixed.source, dates } : null;
}

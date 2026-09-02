/**
 * The lifecycle spec, and the two renderings of it that get checked in.
 *
 * `lifecycle.json` at the repo root is the only place the phases, statuses and
 * item format are written down. Three consumers read it and they read it three
 * different ways, which is not an accident:
 *
 *   - Rust embeds the JSON directly (`include_str!`), so the TUI needs no
 *     generated artifact and no server to draw its docs.
 *   - Markdown cannot import anything, so `docs/LIFECYCLE.md` is generated.
 *
 * There used to be a third — a generated `as const` TypeScript module, because
 * a `.json` import there widens every string and the unions stop being unions.
 * The web app went, and with it the only TypeScript consumer, so the generated
 * module went too. One copy remains, and `kaizen docs --check` fails when it
 * drifts; it runs first in `npm run check`.
 *
 * Both renderers must be pure functions of the spec — no clock, no cwd, no
 * ordering that depends on anything but the file. A generator whose output
 * moves on its own turns the check into noise people learn to skip.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repo root, from `packages/core/src/`. */
export const LIFECYCLE_PATH = join(HERE, '..', '..', '..', 'lifecycle.json');

export function loadLifecycle(path = LIFECYCLE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/* ------------------------------------------------------------ validate ---- */

/**
 * Every way the spec can be internally wrong, as a list of sentences.
 *
 * This is the check that earns the single-source claim. A spec that names a
 * status nothing can reach, or a transition to something that does not exist,
 * would generate documentation that reads fine and describes a machine that
 * cannot run.
 */
export function validateLifecycle(l) {
  const errors = [];
  const statuses = l.statuses ?? [];
  const phases = l.phases ?? [];
  const ids = new Set(statuses.map((s) => s.id));
  const phaseIds = new Set(phases.map((p) => p.id));

  if (!statuses.length) errors.push('no statuses defined');
  if (!phases.length) errors.push('no phases defined');

  const seenAbbrev = new Map();
  for (const s of statuses) {
    if (!phaseIds.has(s.phase)) errors.push(`status "${s.id}": phase "${s.phase}" does not exist`);
    if (typeof s.abbrev !== 'string' || s.abbrev.length !== 3) {
      errors.push(`status "${s.id}": abbrev must be exactly 3 characters (got "${s.abbrev}")`);
    }
    if (seenAbbrev.has(s.abbrev)) {
      errors.push(`status "${s.id}": abbrev "${s.abbrev}" already used by "${seenAbbrev.get(s.abbrev)}"`);
    }
    seenAbbrev.set(s.abbrev, s.id);

    for (const target of s.next ?? []) {
      if (!ids.has(target)) errors.push(`status "${s.id}": next "${target}" does not exist`);
      if (target === s.id) errors.push(`status "${s.id}": transitions to itself`);
    }
    // `terminal` is the property "has no exit". Letting it disagree with `next`
    // is how a preview of this very spec ended up calling `failed` terminal
    // while also routing it back to `planned`.
    const hasNext = (s.next ?? []).length > 0;
    if (s.terminal && hasNext) errors.push(`status "${s.id}": terminal but has next`);
    if (!s.terminal && !hasNext) errors.push(`status "${s.id}": not terminal but has nowhere to go`);
  }

  const fieldIds = new Set((l.fields ?? []).map((f) => f.id));
  for (const p of phases) {
    if (!ids.has(p.produces)) errors.push(`phase "${p.id}": produces "${p.produces}" does not exist`);
    for (const r of p.requires ?? []) {
      if (!fieldIds.has(r)) errors.push(`phase "${p.id}": requires unknown field "${r}"`);
    }
  }
  for (const [i, r] of (l.rungs ?? []).entries()) {
    // Position is meaning here: rung 2 is "one above rung 1", and the docs and
    // the queue both read the number. A gap or a reorder would silently relabel
    // every triaged suggestion on disk.
    if (r.n !== i) errors.push(`rung ${r.n}: rungs must be listed 0..n with no gaps`);
    if (!r.title || !r.detail || !r.cost) errors.push(`rung ${r.n}: needs title, detail and cost`);
  }
  // The session line and the status bar draw these, and the TUI's guide reads
  // the same block to explain them. A glyph that is blank, doubled or two cells
  // wide breaks one of the three without touching the other two.
  const sl = l.statusLine;
  if (sl) {
    if (!sl.mark) errors.push('statusLine: needs a mark');
    if (!sl.help) errors.push('statusLine: needs help text');
    const seenGlyph = new Map();
    const seenPile = new Set();
    for (const pile of sl.piles ?? []) {
      if (!pile.id || !pile.label || !pile.help) errors.push(`pile "${pile.id}": needs id, label and help`);
      if (seenPile.has(pile.id)) errors.push(`pile "${pile.id}": listed twice`);
      seenPile.add(pile.id);
      if ([...(pile.glyph ?? '')].length !== 1) {
        errors.push(`pile "${pile.id}": glyph must be exactly one character (got "${pile.glyph}")`);
      }
      if (seenGlyph.has(pile.glyph)) {
        errors.push(
          `pile "${pile.id}": glyph "${pile.glyph}" already used by "${seenGlyph.get(pile.glyph)}"`,
        );
      }
      seenGlyph.set(pile.glyph, pile.id);
    }
  }

  for (const f of l.fields ?? []) {
    if (!phaseIds.has(f.phase)) errors.push(`field "${f.id}": phase "${f.phase}" does not exist`);
    // Where a field lives is what makes "is it present" answerable. A body field
    // needs its heading spelled out because it is not derivable from the id —
    // `rationale` is written under "Why it matters".
    if (!['frontmatter', 'body', 'sibling'].includes(f.where)) {
      errors.push(`field "${f.id}": where must be frontmatter, body or sibling (got "${f.where}")`);
    }
    if (f.where === 'body' && !f.heading) errors.push(`field "${f.id}": body field needs a heading`);
    if (f.where === 'sibling' && !f.suffix) errors.push(`field "${f.id}": sibling field needs a suffix`);
  }

  // Anything unreachable from the entry status is dead vocabulary.
  const entry = phases[0]?.produces;
  if (entry && ids.has(entry)) {
    const seen = new Set([entry]);
    const queue = [entry];
    while (queue.length) {
      // Shift once into a name. Calling it inside a `find` predicate runs it per
      // element and drains the queue looking for a single match.
      const id = queue.shift();
      const cur = statuses.find((s) => s.id === id);
      for (const n of cur?.next ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    for (const s of statuses) {
      if (!seen.has(s.id)) errors.push(`status "${s.id}": unreachable from "${entry}"`);
    }
  }

  return errors;
}

/* --------------------------------------------------------------- query ---- */

/**
 * The spec, read once.
 *
 * Everything below takes an optional `l` so the tests can ask these questions of
 * a spec they made up, and everything in the running system leaves it out.
 */
let cached;
export function spec() {
  return (cached ??= loadLifecycle());
}

/** Canonical ids, in the order the spec lists them. */
export const statusIds = (l = spec()) => l.statuses.map((s) => s.id);

/**
 * The status, if the spec knows it — otherwise null, so a caller can fall back
 * deliberately rather than propagate a typo through the queue.
 */
export function canonicalStatus(value, l = spec()) {
  return l.statuses.some((s) => s.id === value) ? value : null;
}

/** No exit: the item has left the pipeline for good. */
export function isTerminal(value, l = spec()) {
  const id = canonicalStatus(value, l);
  return !!l.statuses.find((s) => s.id === id)?.terminal;
}

/** Is this move legal? Both sides are canonicalised, so legacy names work. */
export function canTransition(from, to, l = spec()) {
  const a = canonicalStatus(from, l);
  const b = canonicalStatus(to, l);
  if (!a || !b) return false;
  return (l.statuses.find((s) => s.id === a)?.next ?? []).includes(b);
}

/** Where a status is allowed to go next, canonically. */
export function nextStatuses(from, l = spec()) {
  const id = canonicalStatus(from, l);
  return l.statuses.find((s) => s.id === id)?.next ?? [];
}

/** What capture produces — the pile a triage pass consumes. */
export const entryStatus = (l = spec()) => l.phases[0]?.produces ?? 'recorded';

/**
 * The one status that is genuinely waiting on a person.
 *
 * Derived rather than named: find the attended phase, and take what the phase
 * before it produces. That is the pile sitting at the door of the only phase
 * that stops. `approved` is *past* that door — it waits on the server, and
 * counting it as "awaiting you" is what made the session line report 39 items
 * that needed nothing from anyone.
 */
export function awaitingDecision(l = spec()) {
  const at = l.phases.findIndex((p) => p.attended);
  if (at <= 0) return [];
  return [l.phases[at - 1].produces];
}

/**
 * Can the unattended pre-decision pass still move this status forward?
 *
 * True when a legal transition leads into something a phase before the
 * attended one produces — so `recorded` (can become triaged), `triaged` (can
 * become planned) and `failed` (can become planned again) all qualify, while
 * `planned` waits on you and everything later waits on the server. This is
 * the dispatch gate: counting only the untriaged once refused to plan a
 * backlog that was fully triaged and not planned at all.
 */
export function awaitsPass(value, l = spec()) {
  const at = l.phases.findIndex((p) => p.attended);
  if (at <= 0) return false;
  return l.phases.slice(0, at).some((p) => canTransition(value, p.produces, l));
}

/**
 * Is there anything an unattended pass can do for this card *right now*?
 *
 * `awaitsPass` answers for the status alone, which is not the whole question:
 * a card carrying `blocked_on` is parked on something outside the pipeline —
 * a carrier patch that has to land first, a read-only target, a file only you
 * can move. A pass fenced to one of those can do nothing but re-stamp
 * `confirmed_at`, and it costs a model run to find that out, again after every
 * reseat. The field that says so is already in frontmatter, so the gate reads
 * it instead of paying an agent to rediscover it.
 *
 * Takes a built suggestion (`blockedOn`), not raw frontmatter — both callers
 * hold one, and the server's dispatch gate and the TUI's `a` must agree.
 */
export function pendingPass(s, l = spec()) {
  return awaitsPass(s.status, l) && !s.blockedOn;
}

/**
 * Pull a `## Heading` section out of a suggestion body.
 *
 * Lives here because the spec is what says which headings exist and which field
 * each one carries — `rationale` is written under "Why it matters", and that
 * mapping is data now.
 *
 * Scanned line by line rather than matched with one regex. The regex this
 * replaces ended its lookahead with `\Z`, which is a Perl anchor that JavaScript
 * does not have: it compiled to a literal `Z`, so a section with no `##` after
 * it never matched. Rationale is the last heading in almost every file, and 34
 * of 73 suggestions were silently reading as having none.
 */
export function section(body, heading) {
  const lines = String(body ?? '').split(/\r?\n/);
  const wanted = String(heading).toLowerCase();
  const isHeading = (line) => /^##\s/.test(line);
  const start = lines.findIndex((l) => {
    const m = /^##\s+(.*?)\s*$/.exec(l);
    return !!m && m[1].toLowerCase() === wanted;
  });
  if (start === -1) return '';
  const out = [];
  for (let i = start + 1; i < lines.length && !isHeading(lines[i]); i++) out.push(lines[i]);
  return out.join('\n').trim();
}

/** What the phase producing this status insists on before you may leave it. */
export function requirementsFor(status, l = spec()) {
  const id = canonicalStatus(status, l);
  const phase = l.phases.find((p) => p.produces === id);
  if (!phase) return [];
  return (phase.requires ?? []).map((f) => l.fields.find((x) => x.id === f)).filter(Boolean);
}

/**
 * Which of a status's required fields the file does not actually have.
 *
 * Pure, so it can be tested without a filesystem: the caller supplies the
 * parsed frontmatter, the raw body, and whether the sibling patch exists.
 *
 * This is the half of the model that was declared and then not enforced. With
 * only the transition graph checked, `recorded → triaged → planned → approved`
 * walked straight to an approval with no patch behind it — the exact state the
 * spec exists to prevent, reached in three hops instead of one.
 */
export function missingRequirements(status, { data = {}, body = '', hasPatch = false } = {}, l = spec()) {
  const missing = [];
  for (const f of requirementsFor(status, l)) {
    if (f.where === 'frontmatter') {
      if (!String(data[f.id] ?? '').trim()) missing.push(f.id);
    } else if (f.where === 'body') {
      // Present means present *with content*: an empty heading someone left as a
      // placeholder is exactly the thing this is meant to catch.
      if (!section(body, f.heading)) missing.push(f.id);
    } else if (f.where === 'sibling') {
      if (!hasPatch) missing.push(f.id);
    }
  }
  return missing;
}

/** Which phase produces this status, by position. -1 when unknown. */
function phaseIndexOf(id, l) {
  return l.phases.findIndex((p) => p.produces === id);
}

/** The phase that first demands a given field, by position. -1 when none does. */
function phaseRequiring(field, l) {
  return l.phases.findIndex((p) => (p.requires ?? []).includes(field));
}

/**
 * The window in which a patch is owed but no commit exists yet.
 *
 * Derived from the fields rather than named: it is every status from the phase
 * that first requires `patch` up to the one that produces a commit. Today that
 * is `planned` and `approved`. Writing those two down instead would be the
 * seventh copy of the vocabulary, and the one most likely to be forgotten when
 * a phase is inserted.
 */
export function patchWindow(l = spec()) {
  const from = phaseRequiring('patch', l);
  const to = phaseRequiring('applied_sha', l);
  if (from < 0 || to < 0) return [];
  return l.phases.slice(from, to).map((p) => p.produces);
}

/**
 * Is this status in that window? Canonicalises first, so a caller holding a raw
 * frontmatter value — `proposed` straight off disk — gets the right answer
 * without having to know the aliases exist.
 */
export function inPatchWindow(value, l = spec()) {
  return patchWindow(l).includes(canonicalStatus(value, l));
}

/**
 * The legend for the one line a session starts with, and for the segment
 * `kaizen status --bar` draws. Data, so the CLI paints the same glyph the TUI
 * explains — the two used to be a comment in one file and nothing in the other.
 */
export const statusLine = (l = spec()) => l.statusLine ?? { mark: '', help: '', piles: [] };

/** One pile's glyph, by id. Empty for a pile the spec does not name. */
export const pileGlyph = (id, l = spec()) => statusLine(l).piles.find((p) => p.id === id)?.glyph ?? '';

/** Has a commit already come out of this status? */
export function hasLanded(value, l = spec()) {
  const at = phaseRequiring('applied_sha', l);
  const mine = phaseIndexOf(canonicalStatus(value, l), l);
  return at >= 0 && mine >= at;
}

/* -------------------------------------------------------------- render ---- */

const BANNER = (what) =>
  `${what} Generated from lifecycle.json by \`kaizen docs\`. Edit that file, not this one — ` +
  `\`kaizen docs --check\` fails when this drifts.`;

const statusById = (l, id) => l.statuses.find((s) => s.id === id);

/** Prose as markdown lines, so the generator's output does not depend on prettier. */
function wrapAt(text, width) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** How a field is written down, in words. */
const whereOf = (f) =>
  f.where === 'body'
    ? `a \`## ${f.heading}\` section`
    : f.where === 'sibling'
      ? `a sibling \`${f.suffix}\` file`
      : 'frontmatter';

/** The document a human reads in the repo or on GitHub. */
export function renderMarkdown(l) {
  const out = [];
  const push = (...lines) => out.push(...lines);

  push(`<!-- ${BANNER('DO NOT EDIT.')} -->`, '', '# The suggestion lifecycle', '');
  push(
    'A suggestion moves through six phases. It rests in exactly one status between',
    'each, so "where is this" always has one answer.',
    '',
  );

  push('## Phases', '');
  push('| # | Phase | Who runs it | Attended | Comes to rest at |', '|---|---|---|---|---|');
  l.phases.forEach((p, i) => {
    const s = statusById(l, p.produces);
    push(`| ${i + 1} | **${p.title}** | ${p.actor} | ${p.attended ? 'yes' : 'no'} | \`${s.id}\` |`);
  });
  push('');
  for (const p of l.phases) {
    push(`### ${p.title}`, '', p.summary, '');
    if (p.requires?.length) {
      const names = p.requires.map((r) => `\`${r}\``).join(', ');
      push(`Cannot be left until these are present: ${names}.`, '');
    }
  }

  push('## Statuses', '');
  push('| Status | Short | Phase | What it means |', '|---|---|---|---|');
  for (const s of l.statuses) {
    push(`| \`${s.id}\` | \`${s.abbrev}\` | ${s.phase} | ${s.help} |`);
  }
  push('');

  push('## Transitions', '');
  push('```');
  const width = Math.max(...l.statuses.map((s) => s.id.length));
  for (const s of l.statuses) {
    const to = s.next?.length ? s.next.join(' | ') : '(terminal)';
    push(`${s.id.padEnd(width)} → ${to}`);
  }
  push('```', '');

  // State the consequence, derived rather than asserted: if the spec changes so
  // that approval becomes reachable from somewhere else, this sentence changes
  // with it instead of quietly becoming a lie.
  const intoApproved = l.statuses.filter((s) => (s.next ?? []).includes('approved')).map((s) => s.id);
  if (intoApproved.length) {
    const from = intoApproved.map((s) => `\`${s}\``).join(', ');
    push(
      `\`approved\` is reachable only from ${from}, so an approval with no plan behind it`,
      'cannot be written down.',
      '',
    );
  }

  push('## The item format', '');
  push('| Field | Required by | Where it lives | What goes in it |', '|---|---|---|---|');
  for (const f of l.fields) {
    const phase = l.phases.find((p) => p.id === f.phase);
    push(`| \`${f.id}\` | ${phase ? phase.title : f.phase} | ${whereOf(f)} | ${f.help} |`);
  }
  push('');

  // A real template, split by where each field actually goes. The previous one
  // listed every required field as frontmatter, including the four that are
  // `## Heading` sections — so following it produced a file the parser could
  // not read.
  // The ladder lives here because `rung` is one of the fields above, and a
  // number nobody can decode is not a label. It used to be a table in the web
  // app's data layer, which is exactly the wrong place for a piece of doctrine.
  if (l.rungs?.length) {
    push('## The determinism ladder', '');
    push(
      'Every fix is placed on a rung, and may not sit higher than necessary. A fix at',
      'rung 2 or 3 has to say in one sentence why the rung below does not work.',
      '',
    );
    push('| Rung | What it is | Costs | Why |', '|---|---|---|---|');
    for (const r of l.rungs) {
      push(`| **${r.n}** | ${r.title} | ${r.cost} | ${r.detail} |`);
    }
    push('');
  }

  if (l.statusLine?.piles?.length) {
    push('## The status line', '');
    push(...wrapAt(l.statusLine.help, 88), '');
    push('| | Pile | What it counts |', '|---|---|---|');
    for (const pile of l.statusLine.piles) {
      push(`| \`${pile.glyph}\` | ${pile.label} | ${pile.help} |`);
    }
    push('');
  }

  const capture = l.phases[0];
  const required = (capture.requires ?? []).map((id) => l.fields.find((f) => f.id === id)).filter(Boolean);
  push(`### What ${capture.title.toLowerCase()} writes`, '');
  push('```markdown', '---');
  for (const f of required.filter((f) => f.where === 'frontmatter')) push(`${f.id}:`);
  push('---');
  for (const f of required.filter((f) => f.where === 'body')) push('', `## ${f.heading}`, '');
  push('```', '');

  return out.join('\n');
}

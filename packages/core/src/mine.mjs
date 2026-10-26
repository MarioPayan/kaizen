/**
 * `kaizen mine`: a read-only report of capture candidates found in Claude Code's own records.
 * It never files anything; a human or agent decides what, if anything, becomes a capture.
 *
 * Sources (transcript and facet formats are not a stable API, so every field is optional and
 * whatever cannot be read is counted under `parse`):
 *   - `/insights` facets (`<facets>/*.json`): sessions with friction vs. sessions whose transcript
 *     wrote into a feedback dir (capture recall);
 *   - transcripts (`<projects>/<project>/<session>.jsonl`, sidechains skipped):
 *       hook blocks ("Blocked by <guard> …:" followed by "- <trap>" lines) counted per guard/trap,
 *       human messages that open like a correction (English or Spanish),
 *       skill runs (Skill tool calls and slash commands) timed to the next human message, with
 *       the output tokens of the assistant messages in between.
 */
import { createReadStream, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

// Openers that usually push back on the previous turn. A bare "wait", "stop" or "para" is
// usually an instruction ("wait for CI"), so those need punctuation after them.
const CORRECTION = new RegExp(
  [
    // English
    '^(no|nope|wrong|actually|undo|revert)\\b',
    '^(wait|stop|hold on)[,.!]',
    "^(that'?s|this is|it'?s) (not|wrong)\\b",
    '^not what\\b',
    '^i (said|asked|told you|meant)\\b',
    "^(don'?t|do not|never)\\b",
    "^why (did|didn'?t) you\\b",
    "^you (forgot|missed|didn'?t|should(n'?t)?|broke)\\b",
    // Spanish
    '^(nop|incorrecto|ojo)\\b',
    '^(para|pará|espera|mal)[,.!]',
    '^eso no\\b',
    '^est[áa] mal\\b',
    '^te (dije|ped[íi])\\b',
    '^no (era|es eso|es as[íi]|hagas|toques)\\b',
    '^en realidad\\b',
    '^por qu[ée] (hiciste|no|lo)\\b',
    '^deber[íi]as\\b',
    '^(otra vez|de nuevo)\\b',
  ].join('|'),
  'iu',
);

/** Built-in slash commands are not skill runs. */
const BUILTIN_COMMANDS = new Set(
  'add-dir agents artifacts bashes clear compact config context cost doctor effort exit export fast help hooks ide init login logout mcp memory model permissions plugin plugins release-notes resume review rewind status statusline terminal-setup theme upgrade usage vim'.split(
    ' ',
  ),
);

export function isCorrection(text) {
  return CORRECTION.test(String(text ?? '').trim());
}

const BLOCK = /Blocked by (\S+?)[:,]?(?:\s[^\n]*)?:?\n((?:- [^\n]*(?:\n|$))+)/g;

/** Group variants of one trap: code spans and shell variables are collapsed. */
export function trapKey(line) {
  return line
    .replace(/^- /, '')
    .replace(/`[^`]*`/g, '`…`')
    .replace(/\$\{?\w+\}?/g, '$VAR')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function hookBlocks(text) {
  const found = [];
  for (const match of String(text).matchAll(BLOCK))
    for (const line of match[2].split('\n').filter((candidate) => candidate.startsWith('- ')))
      // A guard is a hook script or path, which keeps prose such as "Blocked by upstream:" out.
      if (/[/.]/.test(match[1].replace(/[:.,]+$/, '')))
        found.push({ guard: match[1].replace(/[:.,]+$/, ''), trap: trapKey(line) });
  return found;
}

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => (typeof part === 'string' ? part : (part?.text ?? textOf(part?.content) ?? '')))
          .join('\n')
      : '';

function list(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function transcriptFiles(projectsDir) {
  return list(projectsDir)
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      list(join(projectsDir, entry.name))
        .filter((file) => file.isFile() && file.name.endsWith('.jsonl'))
        .map((file) => ({ project: entry.name, path: join(projectsDir, entry.name, file.name) })),
    );
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

async function readTranscript(file, { since, feedbackMarks, report, runs, blocks }) {
  const sessionId = basename(file.path, '.jsonl');
  const session = { sessionId, project: file.project, firstAt: '', wroteFeedback: false };
  let active = [];
  const seenMessages = new Set();
  const finish = (at) => {
    for (const run of active) {
      const seconds = (Date.parse(at) - Date.parse(run.start)) / 1000;
      const stats = runs.get(run.skill) ?? { durations: [], tokens: 0, runs: 0, unfinished: 0 };
      stats.runs++;
      stats.tokens += run.tokens;
      if (Number.isFinite(seconds) && seconds >= 0) stats.durations.push(seconds);
      else stats.unfinished++;
      runs.set(run.skill, stats);
    }
    active = [];
  };
  const lines = createInterface({ input: createReadStream(file.path), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      report.parse.lines++;
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        report.parse.unparsedLines++;
        continue;
      }
      if (entry.isSidechain || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
      const at = typeof entry.timestamp === 'string' ? entry.timestamp : '';
      if (!at) report.parse.untimed++;
      if (at && !session.firstAt) session.firstAt = at;
      if (since && at && at < since) continue;
      const content = entry.message?.content;
      if (entry.type === 'assistant') {
        const id = entry.message?.id;
        const tokens = Number(entry.message?.usage?.output_tokens) || 0;
        if (!id || !seenMessages.has(id)) {
          if (id) seenMessages.add(id);
          for (const run of active) run.tokens += tokens;
        }
        for (const part of Array.isArray(content) ? content : []) {
          if (part?.type !== 'tool_use') continue;
          if (part.name === 'Skill' && part.input?.skill)
            active.push({ skill: part.input.skill, start: at, tokens: 0 });
          if (!session.wroteFeedback) {
            const input = JSON.stringify(part.input ?? {});
            session.wroteFeedback = feedbackMarks.some((mark) => input.includes(mark));
          }
        }
        continue;
      }
      const parts = Array.isArray(content) ? content : [];
      const results = parts.filter((part) => part?.type === 'tool_result');
      for (const result of results)
        for (const block of hookBlocks(textOf(result.content))) {
          const key = `${block.guard}\0${block.trap}`;
          blocks.set(key, { ...block, count: (blocks.get(key)?.count ?? 0) + 1 });
        }
      if (results.length || entry.isMeta) continue;
      const text = textOf(content).trim();
      if (!text) continue;
      const command = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(text)?.[1];
      if (command && !BUILTIN_COMMANDS.has(command)) {
        finish(at);
        active.push({ skill: command, start: at, tokens: 0 });
        continue;
      }
      if (text.startsWith('<') || text.startsWith('[Request interrupted')) continue;
      finish(at);
      if (isCorrection(text))
        report.corrections.push({
          sessionId,
          project: file.project,
          timestamp: at,
          text: text.replace(/\s+/g, ' ').slice(0, 200),
        });
    }
  } catch (error) {
    report.parse.unreadable.push(`${file.path}: ${error.message}`);
  }
  for (const run of active) {
    const stats = runs.get(run.skill) ?? { durations: [], tokens: 0, runs: 0, unfinished: 0 };
    stats.runs++;
    stats.unfinished++;
    stats.tokens += run.tokens;
    runs.set(run.skill, stats);
  }
  return session;
}

function readFacets(facetsDir, report) {
  const facets = [];
  for (const entry of list(facetsDir)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    report.parse.facets++;
    try {
      const data = JSON.parse(readFileSync(join(facetsDir, entry.name), 'utf8'));
      const friction = Object.fromEntries(
        Object.entries(data.friction_counts ?? {}).filter(([, count]) => Number(count) > 0),
      );
      facets.push({
        sessionId: data.session_id || basename(entry.name, '.json'),
        friction,
        summary: String(data.friction_detail || data.brief_summary || '').slice(0, 200),
      });
    } catch (error) {
      report.parse.unparsedFacets.push(`${entry.name}: ${error.message}`);
    }
  }
  return facets;
}

export async function mine({ projectsDir, facetsDir, feedbackDirs = [], days } = {}) {
  const since = Number.isInteger(days) ? new Date(Date.now() - days * 86400000).toISOString() : '';
  const feedbackMarks = feedbackDirs.flatMap((dir) =>
    dir.startsWith(homedir()) ? [dir, `~${dir.slice(homedir().length)}`] : [dir],
  );
  const report = {
    since: since || null,
    parse: {
      transcripts: 0,
      lines: 0,
      unparsedLines: 0,
      untimed: 0,
      unreadable: [],
      facets: 0,
      unparsedFacets: [],
    },
    corrections: [],
  };
  const runs = new Map();
  const blocks = new Map();
  const sessions = new Map();
  for (const file of transcriptFiles(projectsDir)) {
    report.parse.transcripts++;
    const session = await readTranscript(file, { since, feedbackMarks, report, runs, blocks });
    sessions.set(session.sessionId, session);
  }

  const facets = readFacets(facetsDir, report);
  const frictionTotals = {};
  const missed = [];
  const unevaluated = [];
  let withFriction = 0;
  let captured = 0;
  for (const facet of facets) {
    const session = sessions.get(facet.sessionId);
    if (since && session?.firstAt && session.firstAt < since) continue;
    if (!Object.keys(facet.friction).length) continue;
    withFriction++;
    for (const [category, count] of Object.entries(facet.friction))
      frictionTotals[category] = (frictionTotals[category] ?? 0) + Number(count);
    if (!session) unevaluated.push({ sessionId: facet.sessionId, reason: 'no transcript found' });
    else if (session.wroteFeedback) captured++;
    else missed.push({ ...facet, project: session.project });
  }
  const evaluated = withFriction - unevaluated.length;
  return {
    ...report,
    capture: {
      facets: facets.length,
      withFriction,
      evaluated,
      captured,
      recall: evaluated ? Math.round((captured / evaluated) * 100) / 100 : null,
      frictionTotals,
      missed,
      unevaluated,
    },
    hookBlocks: [...blocks.values()].sort(
      (a, b) => b.count - a.count || a.guard.localeCompare(b.guard) || a.trap.localeCompare(b.trap),
    ),
    skillRuns: [...runs]
      .map(([skill, stats]) => ({
        skill,
        runs: stats.runs,
        timed: stats.durations.length,
        unfinished: stats.unfinished,
        medianSeconds: stats.durations.length ? Math.round(median(stats.durations)) : null,
        totalSeconds: Math.round(stats.durations.reduce((sum, value) => sum + value, 0)),
        outputTokens: stats.tokens,
        meanOutputTokens: stats.runs ? Math.round(stats.tokens / stats.runs) : 0,
      }))
      .sort((a, b) => b.totalSeconds - a.totalSeconds || a.skill.localeCompare(b.skill)),
  };
}

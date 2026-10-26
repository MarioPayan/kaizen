import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookBlocks, isCorrection } from '../src/index.mjs';
import { cleanup, run, workspace, write } from './helpers.mjs';

afterEach(cleanup);

const at = (seconds) => new Date(Date.UTC(2026, 9, 1, 12, 0, seconds)).toISOString();
const user = (seconds, content, extra = {}) => ({
  type: 'user',
  timestamp: at(seconds),
  message: { role: 'user', content },
  ...extra,
});
const assistant = (seconds, id, content, outputTokens = 0) => ({
  type: 'assistant',
  timestamp: at(seconds),
  message: { id, role: 'assistant', content, usage: { output_tokens: outputTokens } },
});
const BLOCK =
  'PreToolUse:Bash hook error: [python3 g.py]: Blocked by ~/.claude/skills/lib/shell/zsh-guard.py (the Bash tool runs zsh):\n' +
  '- zsh reads `$M:p` as a history modifier on $M, not a colon: write `${M}:` instead\n' +
  '- `git add -A` stages every path\n';

function transcripts(root, feedback) {
  const project = join(root, 'projects', '-repo');
  const lines = [
    user(0, '<command-name>/ts:pr-review</command-name>\n<command-args>1</command-args>'),
    assistant(10, 'm1', [{ type: 'text', text: 'reviewing' }], 100),
    assistant(11, 'm1', [{ type: 'tool_use', name: 'Skill', input: { skill: 'babysit-pr' } }], 100),
    user(12, [{ type: 'tool_result', content: [{ type: 'text', text: BLOCK }] }]),
    user(13, [{ type: 'tool_result', content: 'Blocked by upstream:\n- not a hook' }]),
    assistant(
      20,
      'm2',
      [{ type: 'tool_use', name: 'Write', input: { file_path: join(feedback, 'demo', 'x.md') } }],
      50,
    ),
    user(21, 'skill body', { isMeta: true }),
    {
      type: 'assistant',
      isSidechain: true,
      timestamp: at(22),
      message: { id: 's', usage: { output_tokens: 999 } },
    },
    user(120, "No, that's not what I asked"),
    user(130, '<command-name>/clear</command-name>'),
    user(140, 'Te dije que no tocaras eso'),
    user(150, 'Wait for CI to pass, then merge'),
  ];
  write(
    join(project, 'sess-a.jsonl'),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n{"type":"user", broken\n`,
  );
  write(
    join(project, 'sess-d.jsonl'),
    `${JSON.stringify(user(0, 'hola'))}\n${JSON.stringify(assistant(5, 'd1', [{ type: 'tool_use', name: 'Skill', input: { skill: 'kaizen' } }], 7))}\n`,
  );
}

function facets(root) {
  const facet = (id, friction) =>
    write(
      join(root, 'facets', `${id}.json`),
      JSON.stringify({ session_id: id, friction_counts: friction, brief_summary: `summary ${id}` }),
    );
  facet('sess-a', { wrong_approach: 1 });
  facet('sess-b', { buggy_code: 2 });
  facet('sess-c', {});
  facet('sess-d', { buggy_code: 1, misunderstood_request: 0 });
  write(join(root, 'facets', 'broken.json'), '{');
}

describe('kaizen mine', () => {
  it('detects corrections in English and Spanish, but not instructions', () => {
    expect(isCorrection("No, that's wrong")).toBe(true);
    expect(isCorrection('Actually, use blue')).toBe(true);
    expect(isCorrection('Eso no, el otro')).toBe(true);
    expect(isCorrection('Para, no sigas')).toBe(true);
    expect(isCorrection('Wait for the PR to pass')).toBe(false);
    expect(isCorrection('Para mañana, prepara el informe')).toBe(false);
  });

  it('groups hook blocks by guard and normalized trap', () => {
    expect(hookBlocks(BLOCK)).toEqual([
      {
        guard: '~/.claude/skills/lib/shell/zsh-guard.py',
        trap: 'zsh reads `…` as a history modifier on $VAR, not a colon: write `…` instead',
      },
      { guard: '~/.claude/skills/lib/shell/zsh-guard.py', trap: '`…` stages every path' },
    ]);
  });

  it('reports recall, hook blocks, corrections and skill runs from fixtures, and what it could not parse', () => {
    const { root, feedback, config } = workspace();
    transcripts(root, feedback);
    facets(root);
    const result = run(config, 'mine');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.parse).toMatchObject({
      transcripts: 2,
      unparsedLines: 1,
      facets: 5,
      unreadable: [],
    });
    expect(report.parse.unparsedFacets).toHaveLength(1);
    expect(report.capture).toMatchObject({
      facets: 4,
      withFriction: 3,
      evaluated: 2,
      captured: 1,
      recall: 0.5,
      frictionTotals: { wrong_approach: 1, buggy_code: 3 },
      unevaluated: [{ sessionId: 'sess-b', reason: 'no transcript found' }],
    });
    expect(report.capture.missed).toEqual([
      { sessionId: 'sess-d', friction: { buggy_code: 1 }, summary: 'summary sess-d', project: '-repo' },
    ]);
    expect(report.hookBlocks.map((block) => block.count)).toEqual([1, 1]);
    expect(report.corrections.map((item) => item.text)).toEqual([
      "No, that's not what I asked",
      'Te dije que no tocaras eso',
    ]);
    expect(report.skillRuns).toEqual([
      {
        skill: 'ts:pr-review',
        runs: 1,
        timed: 1,
        unfinished: 0,
        medianSeconds: 120,
        totalSeconds: 120,
        outputTokens: 150,
        meanOutputTokens: 150,
      },
      {
        skill: 'babysit-pr',
        runs: 1,
        timed: 1,
        unfinished: 0,
        medianSeconds: 109,
        totalSeconds: 109,
        outputTokens: 50,
        meanOutputTokens: 50,
      },
      {
        skill: 'kaizen',
        runs: 1,
        timed: 0,
        unfinished: 1,
        medianSeconds: null,
        totalSeconds: 0,
        outputTokens: 0,
        meanOutputTokens: 0,
      },
    ]);
    const text = run(config, 'mine', '--text').stdout;
    expect(text).toContain('candidates only; nothing was filed');
    expect(text).toContain('capture recall: 1/2 friction session(s) wrote a capture (50%)');
  });

  it('honours --days and rejects a bad value', () => {
    const { root, feedback, config } = workspace();
    transcripts(root, feedback);
    const report = JSON.parse(run(config, 'mine', '--days', '1').stdout);
    expect(report.corrections).toEqual([]);
    expect(run(config, 'mine', '--days', '0').status).toBe(1);
  });
});

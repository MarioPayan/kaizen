import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'scripts', 'cli.mjs');
const roots = [];

export function cleanup() {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
}

export function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

export function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

/** A git repo holding `skills/`, a feedback dir, empty Claude data dirs and a config pointing at all of it. */
export function workspace(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kaizen-measure-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'skills'), { recursive: true });
  git(root, 'init', '-q', repo);
  for (const dir of ['feedback', 'projects', 'facets']) mkdirSync(join(root, dir));
  const config = join(root, 'config.json');
  const { target = {}, ...rest } = extra;
  writeFileSync(
    config,
    JSON.stringify({
      targets: [{ name: 'user', skills: join(repo, 'skills'), feedback: join(root, 'feedback'), ...target }],
      sources: { projects: join(root, 'projects'), facets: join(root, 'facets') },
      ...rest,
    }),
  );
  return { root, repo, skills: join(repo, 'skills'), feedback: join(root, 'feedback'), config };
}

export function editConfig(config, change) {
  const json = JSON.parse(readFileSync(config, 'utf8'));
  change(json);
  writeFileSync(config, JSON.stringify(json));
}

export function card(feedback, skill, name, { frontmatter = {}, body } = {}) {
  const data = { skill, date: name.slice(0, 10), severity: 'medium', status: 'open', ...frontmatter };
  return write(
    join(feedback, skill, `${name}.md`),
    [
      '---',
      ...Object.entries(data)
        .filter(([, value]) => value !== null)
        .map(([key, value]) => `${key}: ${value}`),
      '---',
      '',
      body ?? '## Context\n\nc\n\n## Suggestion\n\ns\n\n## Evidence\n\ne',
      '',
    ].join('\n'),
  );
}

export function run(config, ...args) {
  const out = openSync(`${config}.stdout`, 'w');
  const err = openSync(`${config}.stderr`, 'w');
  const result = spawnSync('node', [cli, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, KAIZEN_CONFIG: config },
    stdio: ['ignore', out, err],
  });
  closeSync(out);
  closeSync(err);
  return {
    status: result.status,
    stdout: readFileSync(`${config}.stdout`, 'utf8'),
    stderr: readFileSync(`${config}.stderr`, 'utf8'),
  };
}

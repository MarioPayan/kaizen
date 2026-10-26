import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expandPath, resolveSources, resolveTargets } from './config.mjs';
import { lintMemory } from './memory.mjs';
import { retirementCandidates } from './retirement.mjs';
import { scopePath } from './scan.mjs';
import { recurredAfterFix } from './recurrence.mjs';

export const CHECKS = [
  'budget-exceeded',
  'target-root-missing',
  'orphan-feedback-folder',
  'open-item-incomplete',
  'scope-file-missing',
  'recurred-after-fix',
  'memory-path-missing',
  'retirement-candidate',
];

function bytesUnder(path) {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    return readdirSync(path).reduce((total, name) => total + bytesUnder(join(path, name)), 0);
  } catch {
    return 0;
  }
}

export function runDoctor({ config, state }) {
  const findings = [];
  for (const budget of config.budgets ?? []) {
    const path = expandPath(budget.path);
    const bytes = bytesUnder(path);
    if (existsSync(path) && bytes > budget.maxBytes)
      findings.push({
        check: 'budget-exceeded',
        severity: 'medium',
        message: `${path} is ${bytes} bytes; budget is ${budget.maxBytes}`,
      });
  }
  for (const target of resolveTargets(config)) {
    const roots = [['skills', target.skills]];
    if (target.feedback) roots.push(['feedback', target.feedback]);
    for (const [kind, path] of roots) {
      if (!existsSync(path))
        findings.push({
          check: 'target-root-missing',
          severity: 'high',
          target: target.name,
          message: `${kind} root does not exist: ${path}`,
        });
    }
  }
  for (const skill of state.orphans)
    findings.push({
      check: 'orphan-feedback-folder',
      severity: 'low',
      skill,
      message: `feedback folder has no matching skill: ${skill}`,
    });
  const targets = new Map(resolveTargets(config).map((target) => [target.name, target]));
  for (const item of state.suggestions.filter((suggestion) => suggestion.status === 'open')) {
    const missing = ['context', 'suggestion', 'severity'].filter((field) => !item[field]);
    if (missing.length)
      findings.push({
        check: 'open-item-incomplete',
        severity: 'medium',
        id: item.id,
        message: `open item is missing ${missing.join(', ')}`,
      });
    const target = targets.get(item.target);
    const path = target && scopePath(item, target);
    if (item.scope && path && !existsSync(path))
      findings.push({
        check: 'scope-file-missing',
        severity: 'medium',
        id: item.id,
        message: `scope does not exist: ${path}`,
      });
  }
  for (const item of state.suggestions) {
    const recurred = recurredAfterFix(item, targets.get(item.target));
    if (recurred)
      findings.push({
        check: 'recurred-after-fix',
        severity: 'high',
        id: item.id,
        message: `${item.id} was fixed on ${recurred.fixedOn} (${recurred.source}) and recurred ${recurred.dates.length}× after: ${recurred.dates.join(', ')}`,
      });
  }
  for (const { file, reference } of lintMemory({
    projectsDir: resolveSources(config).projects,
    targets: resolveTargets(config),
  }))
    findings.push({
      check: 'memory-path-missing',
      severity: 'low',
      file,
      message: `${file} references ${reference}, which does not exist`,
    });
  for (const candidate of retirementCandidates({ config, state }))
    findings.push({
      check: 'retirement-candidate',
      severity: 'low',
      file: candidate.file,
      message: `${candidate.file}:${candidate.line} origin ${candidate.origins.join(', ')} has no matching suggestion in 60 days (human decides): ${candidate.text.slice(0, 100)}`,
    });
  return findings;
}

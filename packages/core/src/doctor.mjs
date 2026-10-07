import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expandPath, resolveTargets } from './config.mjs';
import { scopePath } from './scan.mjs';

export const CHECKS = [
  'budget-exceeded',
  'target-root-missing',
  'orphan-feedback-folder',
  'open-item-incomplete',
  'scope-file-missing',
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
  return findings;
}

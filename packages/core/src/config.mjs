import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';

export const CONFIG_VERSION = 1;

export function expandPath(value) {
  if (typeof value !== 'string' || !value) return value;
  return resolve(value === '~' || value.startsWith(`~${sep}`) ? homedir() + value.slice(1) : value);
}

export function configPath() {
  return process.env.KAIZEN_CONFIG
    ? expandPath(process.env.KAIZEN_CONFIG)
    : resolve(homedir(), '.claude', 'kaizen', 'config.json');
}

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    targets: [],
    scan: { enabled: false, roots: [], depth: 3 },
    cadence: { sessionHook: true },
    budgets: [],
  };
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['config is not an object'];
  const errors = [];
  if (!Array.isArray(config.targets)) errors.push('targets must be an array');
  else {
    const names = [];
    config.targets.forEach((target, index) => {
      if (!target || typeof target !== 'object' || Array.isArray(target)) {
        errors.push(`targets[${index}] is not an object`);
        return;
      }
      if (typeof target.name !== 'string' || !target.name) errors.push(`targets[${index}].name is required`);
      else names.push(target.name);
      if (typeof target.skills !== 'string' || !target.skills)
        errors.push(`targets[${index}].skills is required`);
      if (target.feedback !== undefined && (typeof target.feedback !== 'string' || !target.feedback))
        errors.push(`targets[${index}].feedback must be a non-empty path`);
    });
    if (new Set(names).size !== names.length) errors.push('target names must be unique');
  }
  if (config.scan) {
    if (!Array.isArray(config.scan.roots)) errors.push('scan.roots must be an array');
    if (!Number.isInteger(config.scan.depth) || config.scan.depth < 1 || config.scan.depth > 8)
      errors.push('scan.depth must be an integer between 1 and 8');
  }
  if (config.budgets !== undefined) {
    if (!Array.isArray(config.budgets)) errors.push('budgets must be an array');
    else
      config.budgets.forEach((budget, index) => {
        if (!budget || typeof budget.path !== 'string' || !budget.path)
          errors.push(`budgets[${index}].path must be a non-empty path`);
        if (!Number.isInteger(budget?.maxBytes) || budget.maxBytes < 0)
          errors.push(`budgets[${index}].maxBytes must be a non-negative integer`);
      });
  }
  return errors;
}

function merge(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over ?? {}))
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) ? { ...base[key], ...value } : value;
  return out;
}

export function withDefaults(config) {
  return merge(defaultConfig(), config);
}

export function loadConfig(path = configPath()) {
  const defaults = defaultConfig();
  if (!existsSync(path)) return { config: defaults, exists: false, path, errors: [] };
  try {
    const config = merge(defaults, JSON.parse(readFileSync(path, 'utf8')));
    return { config, exists: true, path, errors: validateConfig(config) };
  } catch (error) {
    return { config: defaults, exists: true, path, errors: [`config is not valid JSON: ${error.message}`] };
  }
}

export function saveConfig(config, path = configPath()) {
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`invalid config:\n  ${errors.join('\n  ')}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

export function resolveTargets(config) {
  return (config.targets ?? []).map((target) => ({
    ...target,
    skills: expandPath(target.skills),
    feedback: target.feedback ? expandPath(target.feedback) : '',
  }));
}

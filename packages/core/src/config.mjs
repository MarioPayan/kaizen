/**
 * Configuration for kaizen.
 *
 * Deliberately contains no user-specific paths. Defaults are *computed* from the
 * environment at load time and `targets` starts empty — `kaizen init` discovers
 * or asks. A shipped config that named someone's home directory would make this
 * plugin work for exactly one person.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { TYPES, OBJECTIVES, EFFORTS, SEVERITIES, defaultSurface } from './taxonomy.mjs';

export const CONFIG_VERSION = 1;

/** Expand a leading `~` and resolve to an absolute path. */
export function expandPath(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  const expanded = p === '~' || p.startsWith(`~${sep}`) ? homedir() + p.slice(1) : p;
  return resolve(expanded);
}

/** Where the config lives. `KAIZEN_CONFIG` wins, for tests and unusual setups. */
export function configPath() {
  return process.env.KAIZEN_CONFIG
    ? expandPath(process.env.KAIZEN_CONFIG)
    : resolve(homedir(), '.claude', 'kaizen', 'config.json');
}

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    // Empty on purpose. `kaizen init` fills this in per machine.
    targets: [],
    // Project-level `.claude/skills` discovery. Opt-in — never scan blindly.
    scan: { enabled: false, roots: [], depth: 3, writable: false },
    cadence: { weekly: 'SUN 09:00', sessionHook: true },
    // Which suggestions the queue and the session line put in front of you. A
    // view preference, not a filter on what gets filed — muted work stays on
    // disk and stays one click away.
    surface: defaultSurface(),
    clusterPromotion: { members: 3, incidents: 5 },
    applyGuards: { requireCleanTree: true, requireDiffApplies: true },
    server: { host: '127.0.0.1', port: 7777 },
  };
}

// Re-exported from their new home in taxonomy.mjs so existing importers of this
// module keep working unchanged.
export { TYPES, OBJECTIVES, EFFORTS };

/** Returns a list of human-readable problems. Empty list means valid. */
export function validateConfig(cfg) {
  const errs = [];
  if (!cfg || typeof cfg !== 'object') return ['config is not an object'];

  if (!Array.isArray(cfg.targets)) {
    errs.push('targets must be an array');
  } else {
    cfg.targets.forEach((t, i) => {
      if (!t || typeof t !== 'object') return errs.push(`targets[${i}] is not an object`);
      if (!t.skills) errs.push(`targets[${i}].skills is required`);
      if (!t.feedback) errs.push(`targets[${i}].feedback is required`);
      if (t.writable !== undefined && typeof t.writable !== 'boolean') {
        errs.push(`targets[${i}].writable must be a boolean`);
      }
    });
    const names = cfg.targets.map((t) => t?.name).filter(Boolean);
    if (new Set(names).size !== names.length) errs.push('target names must be unique');
  }

  if (cfg.scan) {
    if (!Array.isArray(cfg.scan.roots)) errs.push('scan.roots must be an array');
    if (!Number.isInteger(cfg.scan.depth) || cfg.scan.depth < 1 || cfg.scan.depth > 8) {
      errs.push('scan.depth must be an integer between 1 and 8');
    }
    if (cfg.scan.enabled && cfg.scan.roots.length === 0) {
      errs.push('scan.enabled is true but scan.roots is empty');
    }
  }

  if (cfg.clusterPromotion) {
    const { members, incidents } = cfg.clusterPromotion;
    if (!Number.isInteger(members) || members < 2) errs.push('clusterPromotion.members must be >= 2');
    if (!Number.isInteger(incidents) || incidents < 2) errs.push('clusterPromotion.incidents must be >= 2');
  }

  if (cfg.surface) {
    for (const [key, allowed] of [
      ['types', TYPES],
      ['objectives', OBJECTIVES],
    ]) {
      const values = cfg.surface[key];
      if (!Array.isArray(values) || values.length === 0) {
        // Empty is not "show nothing", it is a config that hides its own queue.
        // Same reasoning as `scan.enabled` with no roots: a contradiction, not
        // a preference.
        errs.push(`surface.${key} must be a non-empty array`);
        continue;
      }
      for (const v of values) {
        if (!allowed.includes(v)) errs.push(`surface.${key}: unknown value "${v}"`);
      }
    }
    if (!SEVERITIES.includes(cfg.surface.minSeverity)) {
      errs.push(`surface.minSeverity must be one of ${SEVERITIES}`);
    }
  }

  if (cfg.server) {
    const { port, host } = cfg.server;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) errs.push('server.port must be 1024-65535');
    // Binding beyond loopback would expose file writes to the network. That binding
    // is the entire security boundary here, so it is not a preference.
    if (host !== '127.0.0.1' && host !== 'localhost') errs.push('server.host must be 127.0.0.1');
  }

  return errs;
}

/** Shallow-merge stored config over defaults, one level into nested objects. */
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...base[k], ...v } : v;
  }
  return out;
}

/**
 * Fill in anything a config does not mention.
 *
 * `loadConfig` does this on the way in, but a config can reach the server without
 * passing through it — posted from the raw JSON editor, or handed straight to
 * `createApp`. A block that is merely absent should behave like its default, not
 * like an undefined the first reader trips over.
 */
export function withDefaults(config) {
  return merge(defaultConfig(), config);
}

export function loadConfig(path = configPath()) {
  const defaults = defaultConfig();
  if (!existsSync(path)) return { config: defaults, exists: false, path, errors: [] };

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { config: defaults, exists: true, path, errors: [`config is not valid JSON: ${e.message}`] };
  }
  const config = merge(defaults, raw);
  return { config, exists: true, path, errors: validateConfig(config) };
}

/** Validates before writing — a bad edit fails loudly rather than silently. */
export function saveConfig(config, path = configPath()) {
  const errors = validateConfig(config);
  if (errors.length) {
    const err = new Error(`invalid config:\n  ${errors.join('\n  ')}`);
    err.errors = errors;
    throw err;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  return path;
}

/**
 * Resolve every configured target to absolute paths.
 * `writable` defaults to false: reporting on a repo is safe, patching it is not.
 */
export function resolveTargets(config) {
  return (config.targets ?? []).map((t, i) => ({
    name: t.name ?? `target-${i}`,
    skills: expandPath(t.skills),
    feedback: expandPath(t.feedback),
    writable: t.writable === true,
  }));
}

/**
 * Grouping suggestions that land in the same place.
 *
 * This used to be a 200-line TF-IDF clusterer with a tuned threshold and
 * average-linkage agglomeration. It earned its keep when suggestions arrived
 * with nothing but prose — but capture now requires `scope`, and on the real
 * corpus the vocabulary clustering converged on "same scope file" anyway
 * (supplying scope once collapsed 34 vague groups into 9 that each named one
 * file). So the category IS the key the frontmatter already carries:
 *
 *   category = pin > scope > skill
 *
 * A `category:` (or legacy `cluster:`) pin is a human decision and always
 * wins. `scope` is where the fix lands — one category per fix. A suggestion
 * with neither groups under its skill, which is exactly the "this skill keeps
 * filing unlabelled problems" bucket triage should see.
 *
 * Deterministic by construction: no threshold to tune, no linkage to argue
 * about, and the same corpus always produces the same categories.
 */

function daysBetween(a, b) {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : 0;
}

/**
 * @param {object[]} suggestions
 * @param {object}   [opts]
 * @param {{members:number, incidents:number}} [opts.promotion]
 */
export function categorize(suggestions, opts = {}) {
  const promotion = opts.promotion ?? { members: 3, incidents: 5 };
  const groups = new Map();
  for (const s of suggestions) {
    const key = s.categoryPin || s.scope || `skill:${s.skill}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  return [...groups.entries()]
    .map(([id, items]) => {
      const incidents = items.reduce((sum, s) => sum + s.incidents, 0);
      const dates = items
        .map((s) => s.date)
        .filter(Boolean)
        .sort();
      return {
        id,
        pinned: items.some((s) => s.categoryPin),
        members: items.map((s) => s.id),
        size: items.length,
        incidents,
        score: Number(items.reduce((sum, s) => sum + s.score, 0).toFixed(2)),
        skills: [...new Set(items.map((s) => s.skill))].sort(),
        scopes: [...new Set(items.map((s) => s.scope).filter(Boolean))].sort(),
        first: dates[0] ?? '',
        last: dates.at(-1) ?? '',
        spanDays: dates.length > 1 ? daysBetween(dates[0], dates.at(-1)) : 0,
        // Past this line, patching one skill's prose is no longer an acceptable
        // fix — the category has earned a rung 0 or rung 1 solution.
        promoted: items.length >= promotion.members || incidents >= promotion.incidents,
      };
    })
    .sort((a, b) => b.incidents - a.incidents || b.score - a.score);
}

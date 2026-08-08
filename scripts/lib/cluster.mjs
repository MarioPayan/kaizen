/**
 * Grouping suggestions that describe the same underlying failure.
 *
 * This is deliberately mechanical. Recurring failures are what justify fixing a
 * thing once at a low rung instead of patching six skills, so the grouping that
 * drives that decision should be reproducible rather than re-argued every run.
 *
 * Three choices here were made against real data rather than by taste:
 *
 *   Body text is part of the vocabulary. Slugs alone are too thin — untriaged
 *   suggestions have no `scope` yet, and "find-local-clone-checks-only-origin"
 *   shares just one word with "push-remote-not-always-origin". The prose in
 *   Context and Suggestion is where the shared vocabulary actually lives.
 *
 *   Rare words count more. Two suggestions sharing "origin" and "worktree" are
 *   related; two sharing "check" and "step" are not. IDF weighting encodes that.
 *
 *   Average linkage, not single linkage. Single linkage chains: one borderline
 *   pair drags two unrelated groups together, and on this corpus it merged the
 *   CI-watch failures into the review-findings ones through a single weak link.
 *   Average linkage requires a group to resemble a group.
 *
 * Over-merging is worse than under-merging. A wrong merge produces a confident
 * wrong conclusion ("these six share one fix"); a missed merge only means triage
 * does more work, and a human can always pin a cluster explicitly in frontmatter.
 */

const STOPWORDS = new Set(
  [
    'a an and are as at be but by for from in into is it its no not of on or so that the then to was',
    'when with this you we if can has have which than one two all any each per via use used using',
    'step add also before after only same other new run runs make does would should could more most',
    'just now still even they them their there here what how why who where instead rather because',
    'since while both either some such very well back out over under again once file files path paths',
    'line lines case cases note notes see like get set put end key keys name names value values list',
    'item items part way time work need want know look find give take come keep let say tell ask try',
    'turn move call open close read write send show stop start wait md lib skill skills',
  ]
    .join(' ')
    .split(' '),
);

/** Default similarity to merge two groups. Tuned against a 66-file corpus. */
export const DEFAULT_THRESHOLD = 0.13;

/** How much of the prose to read. Enough for vocabulary, not so much it dilutes. */
const BODY_CHARS = 1200;

const WEIGHT = { slug: 3, scope: 3, body: 1 };

function words(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** Term-frequency map, with slug and scope words counted more heavily than prose. */
export function termFrequencies(suggestion) {
  const tf = new Map();
  const bump = (token, by) => tf.set(token, (tf.get(token) ?? 0) + by);
  for (const t of new Set(words(suggestion.slug))) bump(t, WEIGHT.slug);
  for (const t of new Set(words(suggestion.scope))) bump(t, WEIGHT.scope);
  const body = `${suggestion.context ?? ''} ${suggestion.suggestion ?? ''}`.slice(0, BODY_CHARS);
  for (const t of words(body)) bump(t, WEIGHT.body);
  return tf;
}

function buildVectors(suggestions) {
  const tfs = suggestions.map(termFrequencies);
  const df = new Map();
  for (const tf of tfs) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);

  const n = tfs.length;
  const idf = (t) => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1;

  const vectors = tfs.map((tf) => {
    const v = new Map();
    for (const [t, count] of tf) v.set(t, (1 + Math.log(count)) * idf(t));
    return v;
  });
  const norms = vectors.map((v) => Math.sqrt([...v.values()].reduce((s, w) => s + w * w, 0)) || 1);
  return { vectors, norms, idf, tfs };
}

function cosine(vectors, norms, i, j) {
  const [a, b] = vectors[i].size <= vectors[j].size ? [vectors[i], vectors[j]] : [vectors[j], vectors[i]];
  let dot = 0;
  for (const [t, w] of a) {
    const w2 = b.get(t);
    if (w2) dot += w * w2;
  }
  return dot / (norms[i] * norms[j]);
}

/**
 * Agglomerative average-linkage.
 *
 * Between-group similarity is kept as a running sum of pairwise scores, so a merge
 * is `sum[a][k] + sum[b][k]` rather than a re-scan of every pair. That keeps the
 * whole thing quadratic instead of cubic, which matters once a corpus outgrows a
 * few hundred files.
 */
function agglomerate(n, pairSim, threshold, canMerge) {
  const groups = Array.from({ length: n }, (_, i) => [i]);
  const sum = groups.map((_, i) => groups.map((_, j) => (i === j ? 0 : pairSim(i, j))));

  for (;;) {
    let best = -Infinity;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (!canMerge(groups[i], groups[j])) continue;
        const avg = sum[i][j] / (groups[i].length * groups[j].length);
        if (avg > best) {
          best = avg;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi === -1 || best < threshold) break;

    groups[bi] = groups[bi].concat(groups[bj]);
    for (let k = 0; k < groups.length; k++) {
      if (k === bi || k === bj) continue;
      sum[bi][k] = sum[k][bi] = sum[bi][k] + sum[bj][k];
    }
    groups.splice(bj, 1);
    sum.splice(bj, 1);
    for (const row of sum) row.splice(bj, 1);
  }
  return groups;
}

/** Name a group from the words that most distinguish it, using slugs only. */
function nameCluster(members, suggestions, idf) {
  const weight = new Map();
  for (const i of members) {
    for (const t of new Set(words(suggestions[i].slug))) {
      weight.set(t, (weight.get(t) ?? 0) + idf(t));
    }
  }
  const top = [...weight.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([t]) => t);
  return top.join('-') || 'misc';
}

function daysBetween(a, b) {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : 0;
}

/**
 * @param {object[]} suggestions
 * @param {object}   [opts]
 * @param {number}   [opts.threshold]
 * @param {{members:number, incidents:number}} [opts.promotion]
 */
export function clusterSuggestions(suggestions, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const promotion = opts.promotion ?? { members: 3, incidents: 5 };
  if (suggestions.length === 0) return [];

  const { vectors, norms, idf } = buildVectors(suggestions);

  // A pinned cluster is a human decision. Same pin always groups; different pins
  // never do, however similar the text happens to look.
  const pinOf = (i) => suggestions[i].clusterPin || '';
  const pinsIn = (group) => new Set(group.map(pinOf).filter(Boolean));
  const canMerge = (a, b) => {
    const merged = new Set([...pinsIn(a), ...pinsIn(b)]);
    return merged.size <= 1;
  };

  const pairSim = (i, j) => {
    if (pinOf(i) && pinOf(i) === pinOf(j)) return 1;
    const scopeMatch = suggestions[i].scope && suggestions[i].scope === suggestions[j].scope;
    const base = cosine(vectors, norms, i, j);
    // Naming the same target file is the strongest signal available; it should
    // dominate wording differences without overriding an explicit pin.
    return scopeMatch ? Math.max(base, 0.9) : base;
  };

  const groups = agglomerate(suggestions.length, pairSim, threshold, canMerge);

  return groups
    .map((members) => {
      const items = members.map((i) => suggestions[i]);
      const pin = items.find((s) => s.clusterPin)?.clusterPin;
      const incidents = items.reduce((sum, s) => sum + s.incidents, 0);
      const dates = items
        .map((s) => s.date)
        .filter(Boolean)
        .sort();
      return {
        id: pin || nameCluster(members, suggestions, idf),
        pinned: Boolean(pin),
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
        // fix — the cluster has earned a rung 0 or rung 1 solution.
        promoted: items.length >= promotion.members || incidents >= promotion.incidents,
      };
    })
    .sort((a, b) => b.incidents - a.incidents || b.score - a.score);
}

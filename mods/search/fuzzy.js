// Fuzzy matching: every space-separated word of the query must appear in the text, in order of its
// letters. A whole-word substring beats scattered letters; word starts and runs of letters score more.
// match() returns { score, hits } (hits: matched character indexes) or null.

const BOUND = /[\/_\-. :#@()[\]]/;
const atStart = (s, i) => i === 0 || BOUND.test(s[i - 1]) || (s[i] >= "A" && s[i] <= "Z" && s[i - 1] >= "a" && s[i - 1] <= "z");

function word(w, s, l) {
  const sub = l.indexOf(w);
  if (sub >= 0) {
    // Prefer an occurrence at a word start, when there's one later on.
    let at = sub;
    if (!atStart(s, sub)) {
      for (let i = l.indexOf(w, sub + 1); i >= 0; i = l.indexOf(w, i + 1)) if (atStart(s, i)) { at = i; break; }
    }
    const hits = [];
    for (let i = 0; i < w.length; i++) hits.push(at + i);
    return { score: 60 + w.length * 6 + (atStart(s, at) ? 25 : 0) - at * 0.05, hits };
  }
  const hits = [];
  let score = 0;
  let from = 0;
  let starts = 0;
  for (let i = 0; i < w.length; i++) {
    const j = l.indexOf(w[i], from);
    if (j < 0) return null;
    const start = atStart(s, j);
    starts += start ? 1 : 0;
    score += (hits.length && j === hits[hits.length - 1] + 1 ? 5 : 1) + (start ? 4 : 0);
    hits.push(j);
    from = j + 1;
  }
  // Letters strewn across the text only count when they mostly start words ("gsr" for GeneratingStepRow).
  const span = hits[hits.length - 1] - hits[0];
  if (span > w.length * 3 + 4 && starts * 2 < w.length) return null;
  return { score: score - span * 0.08, hits };
}

export function words(q) {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

// `ws`: words(query). `l`: the text lowercased, when the caller keeps it.
export function match(ws, s, l = s.toLowerCase()) {
  if (!ws.length) return { score: 0, hits: [] };
  let score = 0;
  const hits = [];
  for (const w of ws) {
    const m = word(w, s, l);
    if (!m) return null;
    score += m.score;
    hits.push(...m.hits);
  }
  return { score, hits };
}

// A file path: a match inside the file name counts more than one across folders.
export function matchPath(ws, path, lower) {
  const cut = path.lastIndexOf("/") + 1;
  if (ws.length === 1) {
    const base = match(ws, path.slice(cut), lower.slice(cut));
    if (base) return { score: base.score + 40 - path.length * 0.02, hits: base.hits.map((i) => i + cut) };
  }
  const m = match(ws, path, lower);
  return m && { score: m.score - path.length * 0.02, hits: m.hits };
}

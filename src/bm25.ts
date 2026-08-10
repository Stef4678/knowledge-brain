import type { ThoughtRecord } from "./knowledgeBase";

export interface SimilarPair {
  a: string;
  b: string;
  score: number;
}

/**
 * Cosine similarity between two thoughts over their token frequencies.
 * Returns 0..1.
 */
export function tokenCosine(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) {
    return 0;
  }
  const fa = new Map<string, number>();
  const fb = new Map<string, number>();
  for (const t of ta) {
    fa.set(t, (fa.get(t) ?? 0) + 1);
  }
  for (const t of tb) {
    fb.set(t, (fb.get(t) ?? 0) + 1);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, c] of fa) {
    na += c * c;
    const d = fb.get(t) ?? 0;
    if (d > 0) {
      dot += c * d;
    }
  }
  for (const c of fb.values()) {
    nb += c * c;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Find the most similar pairs of thoughts. Local only — no API calls. Uses
 * cosine similarity of title+content tokens. Returns pairs above `threshold`
 * sorted by score descending, capped at `maxResults`.
 */
export function findSimilarPairs(
  records: ThoughtRecord[],
  threshold = 0.35,
  maxResults = 30,
): SimilarPair[] {
  const texts = records.map((r) => `${r.title}\n${r.content}`);
  const pairs: SimilarPair[] = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const score = tokenCosine(texts[i], texts[j]);
      if (score >= threshold) {
        pairs.push({ a: records[i].id, b: records[j].id, score });
      }
    }
  }
  pairs.sort((p, q) => q.score - p.score);
  return pairs.slice(0, maxResults);
}

/**
 * Local BM25 retrieval, ported from the app's SQLite FTS5 layer (db.fts_search).
 *
 * Tokenization mirrors FTS5 `unicode61 remove_diacritics 2`: lowercase, strip
 * diacritics, keep only ASCII alphanumerics, drop stopwords and 1-char tokens.
 * The app ORs the query terms and ranks with BM25 (k1=1.2, b=0.75).
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from had has have he her his how i if in is it " +
    "its may my not of on or our she so that the their then there these they this to " +
    "was we what when where which who why will with would you your " +
    "am bine care cu de dar din este fi pentru pe sa sau se si sunt un o la mai ori " +
    "fara sub peste prin fie intr ca chiar decat dupa inca nici altceva atat iar niciun"
  ).split(/\s+/),
);

export function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

const K1 = 1.2;
const B = 0.75;

interface Posting {
  tf: number;
}

interface DocEntry {
  id: string;
  len: number;
}

export interface Bm25Index {
  search(text: string, limit: number): ThoughtRecord[];
}

interface InternalIndex {
  postings: Map<string, Map<string, Posting>>;
  docs: Map<string, DocEntry>;
  avgdl: number;
}

/**
 * Build a BM25 index over a set of thought records. Pass a stable record list;
 * callers should rebuild (or memoize by version) when records change.
 */
export function buildBm25Index(records: ThoughtRecord[]): Bm25Index {
  const postings = new Map<string, Map<string, Posting>>();
  const docs = new Map<string, DocEntry>();
  let totalLen = 0;

  for (const rec of records) {
    const terms = tokenize(`${rec.title}\n${rec.content}`);
    if (terms.length === 0) {
      continue;
    }
    docs.set(rec.id, { id: rec.id, len: terms.length });
    totalLen += terms.length;
    const counts = new Map<string, number>();
    for (const t of terms) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const [term, tf] of counts) {
      let map = postings.get(term);
      if (!map) {
        map = new Map();
        postings.set(term, map);
      }
      map.set(rec.id, { tf });
    }
  }

  const avgdl = docs.size > 0 ? totalLen / docs.size : 1;

  const internal: InternalIndex = { postings, docs, avgdl };

  return {
    search(text: string, limit: number): ThoughtRecord[] {
      return searchInternal(internal, records, text, limit);
    },
  };
}

function searchInternal(
  idx: InternalIndex,
  records: ThoughtRecord[],
  text: string,
  limit: number,
): ThoughtRecord[] {
  const terms = tokenize(text);
  if (terms.length === 0) {
    return [];
  }
  const recordById = new Map(records.map((r) => [r.id, r] as const));
  const scores = new Map<string, number>();
  const n = idx.docs.size;
  if (n === 0) {
    return [];
  }

  for (const term of terms) {
    const postings = idx.postings.get(term);
    if (!postings) {
      continue;
    }
    const df = postings.size;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (const [docId, posting] of postings) {
      const doc = idx.docs.get(docId);
      if (!doc) {
        continue;
      }
      const tf = posting.tf;
      const denom = tf + K1 * (1 - B + B * (doc.len / idx.avgdl));
      const score = idf * ((tf * (K1 + 1)) / denom);
      scores.set(docId, (scores.get(docId) ?? 0) + score);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => recordById.get(id))
    .filter((r): r is ThoughtRecord => !!r);
}

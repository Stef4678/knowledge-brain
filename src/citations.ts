/** A thought the model cited in its answer. */
export interface Citation {
  id: string;
  title: string;
}

/**
 * Extract inline `[n]` citations from a model answer, mapping each number to
 * the thought the model actually saw in its prompt. Invalid numbers,
 * out-of-range numbers, and already-seen ids are dropped silently; the result
 * is deduped in order of first appearance. The `(?!\()` lookahead avoids
 * matching markdown link text like `[3](url)`.
 */
export function parseCitations(
  content: string,
  retrieved: { id: string; title: string }[],
): Citation[] {
  const byNum = new Map(retrieved.map((r, i) => [i + 1, r]));
  const seen = new Set<string>();
  const out: Citation[] = [];
  const re = /\[(\d{1,2})\](?!\()/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const r = byNum.get(Number(m[1]));
    if (r && !seen.has(r.id)) {
      seen.add(r.id);
      out.push({ id: r.id, title: r.title });
    }
  }
  return out;
}

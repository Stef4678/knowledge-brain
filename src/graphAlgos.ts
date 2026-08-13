import type { ThoughtLink } from "./types";

/**
 * Pure graph algorithms for the graph view: neighborhood BFS and shortest
 * path. Dependency-free so the node test suite can exercise them directly.
 * Both treat edges as UNDIRECTED — a link parent→child is walkable in either
 * direction — so "neighbors" and "paths" make sense between any two thoughts.
 */

function undirectedAdjacency(edges: ThoughtLink[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    let a = adj.get(e.parent_id);
    if (!a) {
      a = new Set();
      adj.set(e.parent_id, a);
    }
    a.add(e.child_id);
    let b = adj.get(e.child_id);
    if (!b) {
      b = new Set();
      adj.set(e.child_id, b);
    }
    b.add(e.parent_id);
  }
  return adj;
}

/**
 * The ids of every node reachable from `center` within `depth` hops (the
 * center itself included). The edge list is expected to be pre-filtered to the
 * currently visible nodes, so the result never reaches hidden thoughts.
 */
export function neighborhoodIds(
  center: string,
  depth: number,
  edges: ThoughtLink[],
): Set<string> {
  const out = new Set([center]);
  if (depth <= 0) {
    return out;
  }
  const adj = undirectedAdjacency(edges);
  let frontier = [center];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!out.has(nb)) {
          out.add(nb);
          next.push(nb);
        }
      }
    }
    if (next.length === 0) {
      break;
    }
    frontier = next;
  }
  return out;
}

/**
 * The shortest undirected path from `source` to `target` as an ordered list of
 * node ids, or null when the two are not connected. `[source]` when they are
 * the same node. When several paths tie, the first found (lowest node id order)
 * wins.
 */
export function findShortestPath(
  source: string,
  target: string,
  edges: ThoughtLink[],
): string[] | null {
  if (source === target) {
    return [source];
  }
  const adj = undirectedAdjacency(edges);
  const prev = new Map<string, string>([[source, source]]);
  const queue: string[] = [source];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === target) {
      break;
    }
    for (const nb of adj.get(cur) ?? []) {
      if (prev.has(nb)) {
        continue;
      }
      prev.set(nb, cur);
      queue.push(nb);
    }
  }
  if (!prev.has(target)) {
    return null;
  }
  const path = [target];
  let cur = target;
  while (cur !== source) {
    cur = prev.get(cur)!;
    path.push(cur);
  }
  return path.reverse();
}

/**
 * Ordered node list chaining the shortest paths between consecutive `ids`.
 * Every cited node is always included — a segment that is disconnected simply
 * starts the next hop at the cited node, so it still gets highlighted on its
 * own rather than being silently dropped. A single id yields `[id]`; empty
 * input yields `[]`.
 */
export function buildContinuousPath(
  ids: string[],
  edges: ThoughtLink[],
): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (out[out.length - 1] !== ids[i]) {
      out.push(ids[i]);
    }
    if (i + 1 >= ids.length) {
      continue;
    }
    const seg = findShortestPath(ids[i], ids[i + 1], edges);
    if (seg) {
      out.push(...seg.slice(1));
    }
  }
  return out;
}

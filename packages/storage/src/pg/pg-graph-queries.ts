import { canTruncateRelationNeighborhood } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { TaskRelationProjectionRow } from "@harness-anything/kernel/internal/ports/projection-contracts.ts";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import { readRelationsInTransaction } from "./pg-relation-queries.ts";
import type { PgTaskProjectionSourceOptions } from "./pg-task-source.ts";
import type { AsyncQueries } from "./pg-runtime-dispatch-queries.ts";

export type PgGraphQueries = AsyncQueries<"readTaskRelationNeighborhood" | "readTaskDependencyClosure">;
type Edge = { readonly next: string; readonly row: TaskRelationProjectionRow };
type Graph = ReadonlyMap<string, readonly Edge[]>;

export function pgGraphQueries(options: PgTaskProjectionSourceOptions): PgGraphQueries {
  const { scope, repoId } = options,
    readers = [...(scope.readers ?? [])];
  const read = <Result>(operation: (client: PoolClient) => Promise<Result>) =>
    withPostgresTransaction(options.pool, operation, scope, { isolationLevel: "repeatable read" });
  // One adjacency seek per distinct reached node/type/direction, including the depth
  // frontier needed to detect overflow. No materialized repository-wide visible set.
  async function load(
    client: PoolClient,
    seeds: readonly string[],
    depth: number,
    outgoing: boolean,
    incoming: boolean,
    types: readonly string[],
    state?: string,
    maxNodes?: number,
  ): Promise<Graph> {
    const graph = new Map<string, Edge[]>(),
      reached = new Set(seeds);
    let frontier = [...reached];
    if (maxNodes !== undefined && reached.size > maxNodes)
      throw new Error(`relation neighborhood node budget ${maxNodes} exceeded`);
    for (let level = 0; level <= depth && frontier.length; level++) {
      const next = new Set<string>();
      for (const ref of frontier) {
        const edges = new Map<string, Edge>();
        for (const relationType of new Set(types)) {
          for (const direction of [
            ...(outgoing ? ["source" as const] : []),
            ...(incoming ? ["target" as const] : []),
          ]) {
            const rows = await readRelationsInTransaction(client, scope, readers, {
              [direction]: ref,
              relationType,
              state,
            });
            for (const row of rows)
              edges.set(row.relationId, {
                next: outgoing && row.sourceRef === ref ? row.targetRef : row.sourceRef,
                row: { ...row, workspaceRevision: null },
              });
          }
        }
        graph.set(ref, [...edges.values()]);
        if (level < depth)
          for (const edge of edges.values())
            if (!reached.has(edge.next)) {
              reached.add(edge.next);
              if (maxNodes !== undefined && reached.size > maxNodes)
                throw new Error(`relation neighborhood node budget ${maxNodes} exceeded`);
              next.add(edge.next);
            }
      }
      frontier = [...next];
    }
    return graph;
  }
  return {
    readTaskRelationNeighborhood: (query) =>
      read(async (client) => {
        checkedRefs([query.seed], "relation neighborhood seed");
        if (query.relationTypes.length === 0) throw new Error("relation neighborhood types requires at least one ref");
        checkedRefs(query.relationTypes, "relation neighborhood types");
        checkedDepth(query.maxDepth, "relation neighborhood");
        if (!Number.isSafeInteger(query.maxNodes) || query.maxNodes < 1 || query.maxNodes > 10_000)
          throw new Error("relation neighborhood node budget must be an integer between 1 and 10000");
        const outgoing = query.direction === "outgoing" || query.direction === "both",
          incoming = query.direction === "incoming" || query.direction === "both";
        if (!outgoing && !incoming) throw new Error("relation neighborhood direction is invalid");
        const graph = await load(
            client,
            [query.seed],
            query.maxDepth,
            outgoing,
            incoming,
            query.relationTypes,
            query.state,
            query.maxNodes,
          ),
          result = walkGraph(graph, [query.seed], query.maxDepth, false);
        if (result.truncated && !canTruncateRelationNeighborhood(query.allowTruncation))
          throw new Error(`relation neighborhood depth limit ${query.maxDepth} exceeded`);
        return { ...(await readCutInTransaction(client, scope, readers, repoId)), ...result };
      }),
    readTaskDependencyClosure: (refs, maxDepth = 256) =>
      read(async (client) => {
        checkedRefs(refs, "dependency closure");
        if (refs.length === 0) return { ...(await readCutInTransaction(client, scope, readers, repoId)), rows: [] };
        checkedDepth(maxDepth, "dependency closure");
        const graph = await load(client, refs, maxDepth, true, false, ["depends-on"]),
          result = walkGraph(graph, refs, maxDepth, true);
        if (result.truncated) throw new Error(`dependency closure depth limit ${maxDepth} exceeded`);
        return { ...(await readCutInTransaction(client, scope, readers, repoId)), rows: result.rows };
      }),
  };
}

/** Preserve the historical simple-path depth boundary (including longer diamond
 * paths), rather than silently replacing it with shortest-path depth. Ancestors
 * outside the current strongly connected component can never be revisited. Dropping
 * those ancestors lets equal suffix states merge: an acyclic diamond no longer
 * enumerates every path. Cyclic components retain their simple-path visited set.
 * All database reads have already been bounded by distinct reached adjacency.
 */
function walkGraph(graph: Graph, seeds: readonly string[], maxDepth: number, closure: boolean) {
  const components = graphComponents(graph),
    found = new Map<string, { row: TaskRelationProjectionRow; depth: number; seed: number; path: string }>();
  let truncated = false;
  for (const [seed, start] of seeds.entries()) {
    if (seeds.indexOf(start) !== seed) continue;
    let frontier = [{ ref: start, visited: new Set([start]), path: start }];
    for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
      const next = new Map<string, (typeof frontier)[number]>();
      for (const walk of frontier)
        for (const { next: ref, row } of graph.get(walk.ref) ?? []) {
          const revisited = walk.visited.has(ref);
          if (closure || (depth < maxDepth && !revisited)) {
            const previous = found.get(row.relationId),
              candidate = { row, depth, seed, path: walk.path };
            if (!previous || compareWitness(candidate, previous) < 0) found.set(row.relationId, candidate);
          }
          if (revisited) continue;
          if (depth === maxDepth) {
            truncated = true;
            continue;
          }
          const visited = components.get(ref) === components.get(walk.ref) ? new Set(walk.visited) : new Set<string>();
          visited.add(ref);
          const path = `${walk.path}\x1f${ref}`,
            key = JSON.stringify([ref, [...visited].sort()]),
            previous = next.get(key);
          if (!previous || compareText(path, previous.path) < 0) next.set(key, { ref, visited, path });
        }
      frontier = [...next.values()];
    }
  }
  const rows = [...found.values()]
    .sort(closure ? compareWitness : (a, b) => compareText(a.row.relationId, b.row.relationId))
    .map(({ row }) => row);
  return { rows, truncated };
}
function compareWitness(
  a: { depth: number; seed: number; path: string; row: TaskRelationProjectionRow },
  b: typeof a,
): number {
  return (
    a.depth - b.depth ||
    a.seed - b.seed ||
    compareText(a.path, b.path) ||
    compareText(a.row.relationId, b.row.relationId)
  );
}
function compareText(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Iterative Kosaraju: no JS recursion stack at the supported depth of 4096. */
function graphComponents(graph: Graph): Map<string, number> {
  const reverse = new Map<string, string[]>(),
    visited = new Set<string>(),
    order: string[] = [];
  for (const [ref, edges] of graph) {
    if (!reverse.has(ref)) reverse.set(ref, []);
    for (const edge of edges) {
      if (!reverse.has(edge.next)) reverse.set(edge.next, []);
      reverse.get(edge.next)!.push(ref);
    }
  }
  for (const ref of reverse.keys()) {
    if (visited.has(ref)) continue;
    const stack: { ref: string; done: boolean }[] = [{ ref, done: false }];
    while (stack.length) {
      const item = stack.pop()!;
      if (item.done) {
        order.push(item.ref);
        continue;
      }
      if (visited.has(item.ref)) continue;
      visited.add(item.ref);
      stack.push({ ...item, done: true });
      for (const edge of graph.get(item.ref) ?? [])
        if (!visited.has(edge.next)) stack.push({ ref: edge.next, done: false });
    }
  }
  const components = new Map<string, number>();
  for (const ref of order.reverse()) {
    if (components.has(ref)) continue;
    const id = components.size,
      stack = [ref];
    while (stack.length) {
      const current = stack.pop()!;
      if (components.has(current)) continue;
      components.set(current, id);
      for (const parent of reverse.get(current) ?? []) if (!components.has(parent)) stack.push(parent);
    }
  }
  return components;
}
function checkedRefs(refs: readonly string[], label: string): void {
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string" || ref.length === 0))
    throw new Error(`${label} requires non-empty string refs`);
}
function checkedDepth(depth: number, label: string): void {
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 4096)
    throw new Error(`${label} depth limit must be an integer between 1 and 4096`);
}

import {
  buildCausalGraphView,
  parseEntityRef,
  relationTypes,
  type CausalGraphEdgeInput,
  type CausalGraphNodeInfo,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { requireSameProjectionCut, type ProjectionCut } from "./task-query-read.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { TaskQueryCell } from "./repo-cell-task-query.ts";

const GRAPH_MAX_DEPTH = 16,
  GRAPH_NODE_BUDGET = 500,
  // Neighborhood reads are indexed per seed; this caps how many seeds (root + decision
  // anchors discovered along the way) one graph call may expand.
  GRAPH_SEED_BUDGET = 128;

/**
 * `ha graph <ref>`: one read-only causal tree over Milestone/Task → Decision/claim → Fact.
 * The traversal state is pure kernel domain code (`buildCausalGraphView`); this module only
 * gathers projection inputs at one cut — the indexed relation neighborhood, the task
 * parent/child structure, and per-ref labels — then wraps the view in a read receipt.
 * Nothing here writes.
 */
export function graphView(cell: TaskQueryCell, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const rawRef = cell.requiredCellText(action.ref, "ref"),
    depth = graphDepth(cell, action.depth),
    initialCut = cell.projection.readCut(),
    root = resolveGraphRoot(cell, rawRef, initialCut),
    // Relation edges hang off decision claim/choice anchors, never the bare decision ref, so a
    // decision root expands to one neighborhood read per anchor and merges them at the same cut.
    neighborhood = (seed: string) =>
      cell.queryRead().relationGraphNeighborhood({
        seed,
        direction: "both",
        relationTypes: [...relationTypes],
        // One extra level beyond the rendered window lets each frontier node say truthfully
        // whether it still has unexpanded incident edges.
        maxDepth: depth + 1,
        maxNodes: GRAPH_NODE_BUDGET,
        allowTruncation: true,
      }),
    reads = [root.ref, ...root.anchors].map(neighborhood),
    edges = new Map(reads.flatMap((entry) => entry.edges.map((edge) => [edge.relationId, edge] as const))),
    taskIndex = cell.projection.readTaskIndex({}),
    taskByRef = new Map(taskIndex.rows.map((row) => [`task/${row.taskId}`, row])),
    structuralChildren: Record<string, { ref: string; type: string }[]> = {},
    structuralParents: Record<string, { ref: string; type: string }> = {},
    anchorRefs = new Set<string>(),
    linkAnchors = (decisionRef: string, anchors: readonly string[]) => {
      for (const anchorRef of anchors) {
        (structuralChildren[decisionRef] ??= []).push({ ref: anchorRef, type: "anchor" });
        structuralParents[anchorRef] = { ref: decisionRef, type: "anchor" };
        anchorRefs.add(anchorRef);
      }
    },
    decisionIdOf = (ref: string) => /^decision\/([^/]+)/u.exec(ref)?.[1];
  linkAnchors(root.ref, root.anchors);
  // The root read alone cannot see edges hanging off sibling anchors of a decision it touches:
  // a task derived from decision/<id>/CH1 never reaches decision/<id>/C1 through relation edges.
  // Expand the anchors of every decision the edge set references — indexed seed reads, bounded
  // by GRAPH_SEED_BUDGET — so a task root also serves the claims that evidence its decision.
  const expandedDecisions = new Set<string>(root.anchors.length === 0 ? [] : [decisionIdOf(root.ref)!]),
    cutReads: ProjectionCut[] = [...reads, taskIndex];
  for (;;) {
    const pending = [
      ...new Set(
        [root.ref, ...[...edges.values()].flatMap((edge) => [edge.sourceRef, edge.targetRef])]
          .map(decisionIdOf)
          .filter((id): id is string => id !== undefined && !expandedDecisions.has(id)),
      ),
    ];
    if (pending.length === 0 || reads.length >= GRAPH_SEED_BUDGET) break;
    const decisionRead = cell.projection.readDecisions(pending);
    cutReads.push(decisionRead);
    const rows = new Map(decisionRead.decisions.map((row) => [row.decisionId, row] as const));
    for (const decisionId of pending) {
      const row = rows.get(decisionId);
      if (row === undefined) {
        expandedDecisions.add(decisionId);
        continue;
      }
      const anchors = [...row.claims, ...row.chosen].map((anchor) => `decision/${decisionId}/${anchor.id}`);
      if (reads.length + anchors.length > GRAPH_SEED_BUDGET) break;
      expandedDecisions.add(decisionId);
      linkAnchors(`decision/${decisionId}`, anchors);
      for (const entry of anchors.map(neighborhood)) {
        reads.push(entry);
        cutReads.push(entry);
        for (const edge of entry.edges) edges.set(edge.relationId, edge);
      }
    }
  }
  // Decisions left unexpanded by the seed budget stay honest: their refs render truncated.
  const unexpandedRefs = new Set(
    [...edges.values()]
      .flatMap((edge) => [edge.sourceRef, edge.targetRef])
      .filter((ref) => {
        const id = decisionIdOf(ref);
        return id !== undefined && !expandedDecisions.has(id);
      }),
  );
  requireSameProjectionCut("graph", [initialCut, ...cutReads]);
  const read = {
    status: reads[0]!.status,
    watermark: reads[0]!.watermark,
    sourceRevision: reads[0]!.sourceRevision,
    edges: [...edges.values()],
    facts: [...new Map(reads.flatMap((entry) => entry.facts.map((fact) => [fact.ref, fact] as const))).values()],
    truncated: reads.some((entry) => entry.truncated === true) || unexpandedRefs.size > 0,
    warnings: [...new Set(reads.flatMap((entry) => entry.warnings))],
  };
  for (const row of taskIndex.rows)
    if (row.parentTaskId !== null) {
      const parentRef = `task/${row.parentTaskId}`;
      structuralParents[`task/${row.taskId}`] = { ref: parentRef, type: "child" };
      (structuralChildren[parentRef] ??= []).push({ ref: `task/${row.taskId}`, type: "child" });
    }
  for (const list of Object.values(structuralChildren)) list.sort((a, b) => a.ref.localeCompare(b.ref));
  const refs = new Set<string>([root.ref, ...root.anchors, ...anchorRefs]);
  for (const edge of read.edges) {
    refs.add(edge.sourceRef);
    refs.add(edge.targetRef);
  }
  const nodes = hydrateGraphNodes(cell, refs, taskByRef, read);
  requireSameProjectionCut("graph", [initialCut, cell.projection.readCut()]);
  const view = buildCausalGraphView({
    rootRef: root.ref,
    depth,
    edges: read.edges.map(
      (edge): CausalGraphEdgeInput => ({
        relationId: edge.relationId,
        sourceRef: edge.sourceRef,
        targetRef: edge.targetRef,
        relationType: edge.relationType,
        direction: edge.direction,
        state: edge.state,
        freshness: edge.freshness,
      }),
    ),
    structuralChildren,
    structuralParents,
    nodes,
    frontierTruncated: read.truncated,
    unexpandedRefs,
  });
  const payload = {
    schema: "causal-graph/v1" as const,
    query: { ref: rawRef, resolvedRef: root.ref, depth },
    root: view.root,
    stats: view.stats,
    status: read.status,
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
    warnings: read.warnings,
  };
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, read.sourceRevision),
    payload,
    read.sourceRevision,
    null,
    read,
  );
}

function graphDepth(cell: TaskQueryCell, value: unknown): number {
  // Default spans the Task -> anchor -> Decision -> anchor -> Fact chain: each anchor hop
  // costs two rendered levels because the owning decision renders between sibling anchors.
  if (value === undefined) return 4;
  const depth = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > GRAPH_MAX_DEPTH)
    throw cell.cellCodedError("invalid_field", `graph depth must be an integer between 1 and ${GRAPH_MAX_DEPTH}.`);
  return depth;
}

interface GraphRoot {
  readonly ref: string;
  /** Decision claim/choice anchors a decision root expands over. */
  readonly anchors: readonly string[];
}

/** Normalize `task_x`, `dec_x[/C1]`, `F-x`, or a milestone/task slug to a canonical entity ref. */
function resolveGraphRoot(cell: TaskQueryCell, raw: string, cut: ProjectionCut): GraphRoot {
  const normalized = raw
      .replace(/^(task_[0-9A-Za-z_-]+)$/u, "task/$1")
      .replace(/^(dec_[0-9A-Za-z]+)((?:\/[A-Za-z0-9_-]+)*)$/u, "decision/$1$2")
      .replace(/^(F-[0-9A-Za-z]+)$/u, "fact/$1"),
    parsed = parseEntityRef(normalized);
  if (parsed !== null) {
    if (parsed.externalHarness)
      throw cell.cellCodedError("invalid_field", `ha graph only reads this repository; ${raw} is external.`);
    const witness = cell.projection.readEntityVersionWitness(normalized);
    if (witness?.currentVersion !== null) {
      if (parsed.kind === "decision" && parsed.anchor === undefined) {
        const read = cell.projection.readDecision(parsed.id);
        requireSameProjectionCut("graph", [cut, read]);
        const row = read.decision;
        return {
          ref: normalized,
          anchors: [...(row?.claims ?? []), ...(row?.chosen ?? [])].map((anchor) => `${normalized}/${anchor.id}`),
        };
      }
      return { ref: normalized, anchors: [] };
    }
    if (parsed.kind !== "task")
      throw cell.cellCodedError("graph_root_unknown", `No entity resolves ${raw} in this repository.`);
    // A hyphenated slug parses syntactically as a task id; fall through to the slug index
    // before declaring the root unknown.
  }
  const slug = parsed !== null && parsed.kind === "task" ? parsed.id : raw,
    read = cell.projection.readTaskIndex({ slug });
  requireSameProjectionCut("graph", [cut, read]);
  const matches = read.rows;
  if (matches.length > 1)
    throw cell.cellCodedError(
      "graph_root_ambiguous",
      `Slug ${raw} matches ${matches.length} tasks (${matches.map((row) => row.taskId).join(", ")}); use a task_<id> ref.`,
    );
  if (matches.length === 1) return { ref: `task/${matches[0]!.taskId}`, anchors: [] };
  throw cell.cellCodedError("graph_root_unknown", `No task, decision, fact, or milestone slug resolves ${raw}.`);
}

function hydrateGraphNodes(
  cell: TaskQueryCell,
  refs: ReadonlySet<string>,
  taskByRef: ReadonlyMap<string, { readonly title: string; readonly status: string; readonly taskClass: string }>,
  read: ProjectionCut & {
    readonly facts: readonly { readonly ref: string; readonly statement: string; readonly liveness: string }[];
  },
): Record<string, CausalGraphNodeInfo> {
  const decisionIds = new Set<string>(),
    factInfo = new Map(read.facts.map((fact) => [fact.ref, fact] as const));
  for (const ref of refs) {
    const decision = /^decision\/([^/]+)/u.exec(ref)?.[1];
    if (decision) decisionIds.add(decision);
  }
  const decisionRead = cell.projection.readDecisions([...decisionIds]);
  requireSameProjectionCut("graph", [read, decisionRead]);
  const decisions = new Map(decisionRead.decisions.map((row) => [row.decisionId, row] as const));
  return Object.fromEntries(
    [...refs].map((ref): readonly [string, CausalGraphNodeInfo] => {
      const parsed = parseEntityRef(ref),
        task = taskByRef.get(ref);
      if (task !== undefined) return [ref, { label: task.title, state: task.status, detail: task.taskClass }];
      if (parsed?.kind === "decision") {
        const row = decisions.get(parsed.id);
        if (parsed.anchor !== undefined) {
          const claim =
            row?.claims.find((entry) => entry.id === parsed.anchor) ??
            row?.chosen.find((entry) => entry.id === parsed.anchor);
          return [ref, { label: claim?.text ?? null, state: row?.state ?? null, detail: `anchor ${parsed.anchor}` }];
        }
        return [ref, { label: row?.title ?? null, state: row?.state ?? null, detail: null }];
      }
      if (parsed?.kind === "fact") {
        const fact = factInfo.get(ref);
        return [ref, { label: fact?.statement ?? null, state: fact?.liveness ?? null, detail: null }];
      }
      return [ref, { label: null, state: null, detail: null }];
    }),
  );
}

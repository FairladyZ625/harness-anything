import {
  buildCausalGraphView,
  parseEntityRef,
  relationTypes,
  type CausalGraphEdgeInput,
  type CausalGraphNodeInfo,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { TaskQueryCell } from "./repo-cell-task-query.ts";

const GRAPH_MAX_DEPTH = 16,
  GRAPH_NODE_BUDGET = 500;

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
    root = resolveGraphRoot(cell, rawRef),
    // Relation edges hang off decision claim/choice anchors, never the bare decision ref, so a
    // decision root expands to one neighborhood read per anchor and merges them at the same cut.
    reads = [root.ref, ...root.anchors].map((seed) =>
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
    ),
    read = {
      status: reads[0]!.status,
      watermark: reads[0]!.watermark,
      sourceRevision: reads[0]!.sourceRevision,
      edges: [
        ...new Map(reads.flatMap((entry) => entry.edges.map((edge) => [edge.relationId, edge] as const))).values(),
      ],
      facts: [...new Map(reads.flatMap((entry) => entry.facts.map((fact) => [fact.ref, fact] as const))).values()],
      truncated: reads.some((entry) => entry.truncated === true),
      warnings: [...new Set(reads.flatMap((entry) => entry.warnings))],
    },
    taskIndex = cell.projection.readTaskIndex({}),
    taskByRef = new Map(taskIndex.rows.map((row) => [`task/${row.taskId}`, row])),
    structuralChildren: Record<string, { ref: string; type: string }[]> = {},
    structuralParents: Record<string, { ref: string; type: string }> = {};
  for (const row of taskIndex.rows)
    if (row.parentTaskId !== null) {
      const parentRef = `task/${row.parentTaskId}`;
      structuralParents[`task/${row.taskId}`] = { ref: parentRef, type: "child" };
      (structuralChildren[parentRef] ??= []).push({ ref: `task/${row.taskId}`, type: "child" });
    }
  for (const anchorRef of root.anchors) {
    (structuralChildren[root.ref] ??= []).push({ ref: anchorRef, type: "anchor" });
    structuralParents[anchorRef] = { ref: root.ref, type: "anchor" };
  }
  for (const list of Object.values(structuralChildren)) list.sort((a, b) => a.ref.localeCompare(b.ref));
  const refs = new Set<string>([root.ref, ...root.anchors]);
  for (const edge of read.edges) {
    refs.add(edge.sourceRef);
    refs.add(edge.targetRef);
  }
  const nodes = hydrateGraphNodes(cell, refs, taskByRef, read);
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
        current: edge.current,
      }),
    ),
    structuralChildren,
    structuralParents,
    nodes,
    frontierTruncated: read.truncated,
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
  if (value === undefined) return 3;
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
function resolveGraphRoot(cell: TaskQueryCell, raw: string): GraphRoot {
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
        const row = cell.projection.readDecision(parsed.id).decision;
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
    matches = cell.projection.readTaskIndex({ slug }).rows;
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
  read: { readonly facts: readonly { readonly ref: string; readonly statement: string; readonly liveness: string }[] },
): Record<string, CausalGraphNodeInfo> {
  const decisionIds = new Set<string>(),
    factInfo = new Map(read.facts.map((fact) => [fact.ref, fact] as const));
  for (const ref of refs) {
    const decision = /^decision\/([^/]+)/u.exec(ref)?.[1];
    if (decision) decisionIds.add(decision);
  }
  const decisions = new Map(
    cell.projection.readDecisions([...decisionIds]).decisions.map((row) => [row.decisionId, row] as const),
  );
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

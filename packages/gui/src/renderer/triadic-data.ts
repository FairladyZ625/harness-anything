import { useQueries, useQuery } from "@tanstack/react-query";
import type {
  DecisionProjectionRow,
  FactProjectionRow,
  RelationCoverageRow,
  RelationGraphEdgeRow
} from "../api/renderer-dto.ts";
import { harnessClient } from "./api-client.ts";
import type {
  DecisionListSuccess,
  RelationGraphSuccess,
  TaskFactListSuccess
} from "./api-client.ts";
import { KIND_LABEL } from "./graph/constants.ts";
import type { DecisionClaim, DecisionRow, DecisionState, FactRef, RelationEdge } from "./model/types.ts";

export const triadicQueryKeys = {
  all: ["harness", "triadic"] as const,
  graph: () => [...triadicQueryKeys.all, "relation-graph"] as const,
  decisions: () => [...triadicQueryKeys.all, "decisions"] as const,
  facts: (taskId: string) => [...triadicQueryKeys.all, "task-facts", taskId] as const
};

export function useTriadicProjectionQuery() {
  const graph = useQuery({
    queryKey: triadicQueryKeys.graph(),
    queryFn: () => harnessClient.getRelationGraph(),
    staleTime: 10_000
  });
  const decisions = useQuery({
    queryKey: triadicQueryKeys.decisions(),
    queryFn: () => harnessClient.getDecisions(),
    staleTime: 10_000
  });
  const taskIds = graph.data ? [...new Set(graph.data.factAnchors.map((anchor) => anchor.taskId))].sort() : [];
  const factQueries = useQueries({
    queries: taskIds.map((taskId) => ({
      queryKey: triadicQueryKeys.facts(taskId),
      queryFn: () => harnessClient.getTaskFacts({ taskId }),
      staleTime: 10_000,
      enabled: graph.isSuccess
    }))
  });

  const rendererData = buildTriadicRendererData({
    graph: graph.data ?? emptyRelationGraph,
    decisions: decisions.data ?? emptyDecisionList,
    factResults: factQueries.flatMap((query) => query.data ? [query.data] : [])
  });
  const isLoading = graph.isLoading || decisions.isLoading || factQueries.some((query) => query.isLoading);
  const isError = graph.isError || decisions.isError || factQueries.some((query) => query.isError);

  return {
    isLoading,
    isError,
    ...rendererData
  };
}

export interface TriadicRendererData {
  readonly decisions: DecisionRow[];
  readonly facts: FactRef[];
  readonly relations: RelationEdge[];
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: RelationGraphSuccess["factAnchors"];
  readonly warnings: unknown[];
}

/**
 * Converts the public GUI bridge DTOs into the renderer's triadic model.
 * Keeping this pure makes the complete ledger -> bridge -> renderer path
 * testable without adding a second read path beside the daemon service.
 */
export function buildTriadicRendererData(input: {
  readonly graph: RelationGraphSuccess;
  readonly decisions: DecisionListSuccess;
  readonly factResults: ReadonlyArray<TaskFactListSuccess>;
}): TriadicRendererData {
  const relationRows = input.graph.edges;
  const factRows = input.factResults.flatMap((result) => result.facts);
  return {
    decisions: adaptDecisionRows(input.decisions.decisions, relationRows, input.graph.coverageRows),
    facts: adaptFactRows(factRows, relationRows),
    relations: adaptRelationRows(relationRows),
    coverageRows: input.graph.coverageRows,
    factAnchors: input.graph.factAnchors,
    warnings: [...input.graph.warnings, ...input.decisions.warnings]
  };
}

const emptyRelationGraph: RelationGraphSuccess = {
  ok: true,
  edges: [],
  coverageRows: [],
  factAnchors: [],
  warnings: []
};

const emptyDecisionList: DecisionListSuccess = {
  ok: true,
  decisions: [],
  warnings: []
};

function adaptRelationRows(rows: ReadonlyArray<RelationGraphEdgeRow>): RelationEdge[] {
  const edges: RelationEdge[] = [];
  for (const row of rows) {
    if (!isKernelRelationKind(row.relationType)) continue;
    edges.push({
      from: row.sourceRef,
      to: row.targetRef,
      kind: row.relationType,
      provenance: row.origin === "imported_snapshot" ? "external-engine" : "local-document",
      rationale: row.rationale
    });
  }
  return edges;
}

function isKernelRelationKind(value: string): value is RelationEdge["kind"] {
  return Object.hasOwn(KIND_LABEL, value);
}

function adaptFactRows(
  rows: ReadonlyArray<FactProjectionRow>,
  relationRows: ReadonlyArray<RelationGraphEdgeRow>
): FactRef[] {
  const invalidated = new Set(
    relationRows.flatMap((row) => {
      if (row.relationType === "invalidated-by" && row.sourceRef.startsWith("fact/")) {
        return [row.sourceRef];
      }
      if (row.relationType === "supersedes-fact" && row.targetRef.startsWith("fact/")) {
        return [row.targetRef];
      }
      return [];
    })
  );
  return rows.map((row) => ({
    anchor: `${row.taskId}/${row.factId}`,
    taskId: row.taskId,
    category: factCategory(row),
    text: row.statement,
    at: row.observedAt,
    confidence: row.confidence,
    source: row.source,
    provenance: row.provenance,
    invalidated: invalidated.has(row.ref)
  }));
}

function adaptDecisionRows(
  rows: ReadonlyArray<DecisionProjectionRow>,
  relationRows: ReadonlyArray<RelationGraphEdgeRow>,
  coverageRows: ReadonlyArray<RelationCoverageRow>
): DecisionRow[] {
  const relationsBySource = new Map<string, string[]>();
  for (const row of relationRows) {
    if (!row.targetRef.startsWith("fact/")) continue;
    const values = relationsBySource.get(row.sourceRef) ?? [];
    values.push(row.targetRef);
    relationsBySource.set(row.sourceRef, values);
  }
  for (const row of coverageRows) {
    if (!row.coveringFactRef) continue;
    const values = relationsBySource.get(row.claimRef) ?? [];
    values.push(row.coveringFactRef);
    relationsBySource.set(row.claimRef, values);
  }

  return rows.map((row) => {
    const chosen = row.chosen.map((text, index) => decisionClaim(row.decisionId, "CH", index, text, relationsBySource));
    const rejected = row.rejected.map((entry, index) => ({
      ...decisionClaim(row.decisionId, "RJ", index, entry.text, relationsBySource),
      whyNot: entry.whyNot
    }));
    return {
      decisionId: row.decisionId,
      title: row.title,
      state: decisionState(row.state),
      riskTier: row.riskTier,
      urgency: row.urgency,
      vertical: row.vertical,
      preset: row.preset,
      attribution: row.attribution,
      proposedAt: row.proposedAt,
      decidedAt: row.decidedAt,
      question: row.question,
      chosen,
      rejected,
      claims: [...chosen, ...rejected].map((claim) => ({ id: claim.id, text: claim.text })),
      provenance: row.provenance,
      lastChangedAt: row.decidedAt
    };
  });
}

function decisionClaim(
  decisionId: string,
  prefix: "CH" | "RJ",
  index: number,
  text: string,
  relationsBySource: ReadonlyMap<string, ReadonlyArray<string>>
): DecisionClaim {
  const id = `${prefix}${index + 1}`;
  const ref = `decision/${decisionId}/${id}`;
  return {
    id,
    text,
    evidence: [...new Set(relationsBySource.get(ref) ?? [])]
  };
}

function factCategory(row: FactProjectionRow): FactRef["category"] {
  if (row.memoryClass === "semantic") return "finding";
  if (row.memoryClass === "procedural") return "lesson";
  return "progress";
}

function decisionState(value: string): DecisionState {
  if (value === "proposed" || value === "rejected" || value === "deferred" || value === "active" || value === "retired") return value;
  return "proposed";
}

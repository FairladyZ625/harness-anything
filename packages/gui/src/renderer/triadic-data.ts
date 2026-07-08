import { useQueries, useQuery } from "@tanstack/react-query";
import type {
  DecisionProjectionRow,
  FactProjectionRow,
  RelationCoverageRow,
  RelationGraphEdgeRow
} from "../api/renderer-dto.ts";
import { harnessClient } from "./api-client.ts";
import type { DecisionClaim, DecisionRow, DecisionState, FactRef, RelationEdge, RelationKind } from "./model/types.ts";

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

  const factRows = factQueries.flatMap((query) => query.data?.facts ?? []);
  const relationRows = graph.data?.edges ?? [];
  const coverageRows = graph.data?.coverageRows ?? [];
  const facts = adaptFactRows(factRows, relationRows);
  const relations = adaptRelationRows(relationRows);
  const adaptedDecisions = adaptDecisionRows(decisions.data?.decisions ?? [], relationRows, coverageRows);
  const isLoading = graph.isLoading || decisions.isLoading || factQueries.some((query) => query.isLoading);
  const isError = graph.isError || decisions.isError || factQueries.some((query) => query.isError);

  return {
    isLoading,
    isError,
    decisions: adaptedDecisions,
    facts,
    relations,
    warnings: [
      ...(graph.data?.warnings ?? []),
      ...(decisions.data?.warnings ?? []),
      ...factQueries.flatMap((query) => query.data ? [] : [])
    ]
  };
}

function adaptRelationRows(rows: ReadonlyArray<RelationGraphEdgeRow>): RelationEdge[] {
  return rows.map((row) => ({
    from: row.sourceRef,
    to: row.targetRef,
    kind: row.relationType as RelationKind,
    provenance: row.origin === "imported_snapshot" ? "external-engine" : "local-document",
    rationale: row.rationale
  }));
}

function adaptFactRows(
  rows: ReadonlyArray<FactProjectionRow>,
  relationRows: ReadonlyArray<RelationGraphEdgeRow>
): FactRef[] {
  const invalidated = new Set(
    relationRows
      .filter((row) => row.targetRef.startsWith("fact/") && (row.relationType === "invalidated-by" || row.relationType === "supersedes-fact"))
      .map((row) => row.targetRef)
  );
  return rows.map((row) => ({
    anchor: `${row.taskId}/${row.factId}`,
    taskId: row.taskId,
    category: factCategory(row),
    text: row.statement,
    at: row.observedAt,
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
      riskTier: "medium",
      urgency: "medium",
      vertical: row.moduleKeys[0] ?? "software/coding",
      preset: "decision-projection",
      proposedBy: { kind: "system", id: "projection" },
      proposedAt: row.decidedAt ?? "1970-01-01T00:00:00.000Z",
      decidedAt: row.decidedAt,
      question: row.question,
      chosen,
      rejected,
      claims: [...chosen, ...rejected].map((claim) => ({ id: claim.id, text: claim.text })),
      provenance: [],
      lastChangedAt: row.decidedAt ?? "1970-01-01T00:00:00.000Z"
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

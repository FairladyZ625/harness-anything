import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DecisionProjectionRow, RelationCoverageRow, RelationGraphEdgeRow } from "../api/renderer-dto.ts";
import { harnessClient } from "./api-client.ts";
import type { DecisionListSuccess, RelationGraphSuccess } from "./api-client.ts";
import { KIND_LABEL } from "./graph/constants.ts";
import type { DecisionClaim, DecisionRow, DecisionState, FactRef, RelationEdge } from "./model/types.ts";

export const triadicQueryKeys = {
  all: (repoId: string) => ["triadic", repoId] as const,
  graph: (repoId: string) => ["triadic", repoId, "relation-graph"] as const,
  decisions: (repoId: string) => ["triadic", repoId, "decisions"] as const,
};

export function useTriadicProjectionQuery(repoId: string | null) {
  const graph = useQuery({
    queryKey: triadicQueryKeys.graph(repoId ?? "unselected"),
    queryFn: () => harnessClient.getRelationGraph({ repoId: repoId! }),
    enabled: repoId !== null,
    staleTime: 10_000,
  });
  const decisions = useQuery({
    queryKey: triadicQueryKeys.decisions(repoId ?? "unselected"),
    queryFn: () => harnessClient.getDecisions({ repoId: repoId! }),
    enabled: repoId !== null,
    staleTime: 10_000,
  });
  const rendererData = useMemo(
    () =>
      buildTriadicRendererData({
        graph: graph.data ?? emptyRelationGraph,
        decisions: decisions.data ?? emptyDecisionList,
      }),
    [graph.data, decisions.data],
  );
  const isLoading = graph.isLoading || decisions.isLoading;
  const isError = graph.isError || decisions.isError;

  return useMemo(
    () => ({
      isLoading,
      isError,
      relationState: graph.isError ? ("error" as const) : graph.isLoading ? ("loading" as const) : ("ready" as const),
      relationWarnings: graph.data?.warnings ?? [],
      ...rendererData,
    }),
    [isLoading, isError, graph.isError, graph.isLoading, graph.data?.warnings, rendererData],
  );
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
}): TriadicRendererData {
  const relationRows = input.graph.edges;
  return {
    decisions: adaptDecisionRows(input.decisions.decisions, relationRows, input.graph.coverageRows),
    facts: input.graph.facts.map((row) => ({
      anchor: `${row.taskId}/${row.factId}`,
      taskId: row.taskId,
      category: row.memoryClass === "semantic" ? "lesson" : row.memoryClass === "procedural" ? "progress" : "finding",
      text: row.statement,
      at: row.observedAt,
      confidence: row.confidence,
      source: row.source,
      provenance: row.provenance,
      invalidated:
        /* @gate-identity check-gui-status-judgments/gui-status-055 */
        row.liveness === "superseded_fact",
    })),
    relations: adaptRelationRows(relationRows),
    coverageRows: input.graph.coverageRows,
    factAnchors: input.graph.factAnchors,
    warnings: [...input.graph.warnings, ...input.decisions.warnings],
  };
}

const emptyRelationGraph: RelationGraphSuccess = {
  ok: true,
  edges: [],
  coverageRows: [],
  factAnchors: [],
  facts: [],
  warnings: [],
};

const emptyDecisionList: DecisionListSuccess = {
  ok: true,
  decisions: [],
  warnings: [],
};

function adaptRelationRows(rows: ReadonlyArray<RelationGraphEdgeRow>): RelationEdge[] {
  const edges: RelationEdge[] = [];
  for (const row of rows) {
    if (
      /* @gate-identity check-gui-status-judgments/gui-status-056 */
      row.state !== "active"
    )
      continue;
    if (!isKernelRelationKind(row.relationType)) continue;
    edges.push({
      relationId: row.relationId,
      from: row.sourceRef,
      to: row.targetRef,
      kind: row.relationType,
      direction: row.direction,
      state: row.state,
      provenance: row.origin === "imported_snapshot" ? "external-engine" : "local-document",
      rationale: row.rationale,
    });
  }
  return edges;
}

function isKernelRelationKind(value: string): value is RelationEdge["kind"] {
  return Object.hasOwn(KIND_LABEL, value);
}

function adaptDecisionRows(
  rows: ReadonlyArray<DecisionProjectionRow>,
  relationRows: ReadonlyArray<RelationGraphEdgeRow>,
  coverageRows: ReadonlyArray<RelationCoverageRow>,
): DecisionRow[] {
  const relationsBySource = new Map<string, string[]>();
  for (const row of relationRows) {
    if (
      /* @gate-identity check-gui-status-judgments/gui-status-057 */
      row.state !== "active"
    )
      continue;
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
    const chosen = row.chosen.map((entry) => ({
      ...decisionClaim(row.decisionId, entry.id, entry.text, relationsBySource),
      ...(entry.rationale ? { rationale: entry.rationale } : {}),
    }));
    const rejected = row.rejected.map((entry) => ({
      ...decisionClaim(row.decisionId, entry.id, entry.text, relationsBySource),
      whyNot: entry.whyNot,
    }));
    return {
      decisionId: row.decisionId,
      ...(row.legacyId ? { legacyId: row.legacyId } : {}),
      path: row.path,
      title: row.title,
      state: decisionState(row.state),
      riskTier: row.riskTier,
      urgency: row.urgency,
      vertical: row.vertical,
      preset: row.preset,
      decisionClass: row.decisionClass,
      workspaceRevision: row.workspaceRevision,
      proposedBy: actorRef(row.proposer),
      proposedAt: row.proposedAt,
      ...(row.arbiter ? { arbiter: actorRef(row.arbiter) } : {}),
      ...(row.decidedAt ? { decidedAt: row.decidedAt } : {}),
      question: row.question,
      chosen,
      rejected,
      claims: row.claims.map((claim) => ({
        id: claim.id,
        text: claim.text,
        loadBearing: claim.loadBearing,
        fulfillment: claim.fulfillment,
      })),
      judgmentConsents: row.judgmentConsents.map((consent) => ({ ...consent })),
      body: row.body ? { ...row.body } : null,
      appliesTo: { modules: [...row.appliesTo.modules], productLines: [...row.appliesTo.productLines] },
      ...(row.readiness
        ? {
            readinessSignals: {
              appliesToDrift: { ...row.readiness.appliesToDrift, paths: [...row.readiness.appliesToDrift.paths] },
              conflictMarker: { ...row.readiness.conflictMarker, paths: [...row.readiness.conflictMarker.paths] },
            },
          }
        : {}),
      lastChangedAt: row.decidedAt ?? row.proposedAt,
    };
  });
}

function decisionClaim(
  decisionId: string,
  id: string,
  text: string,
  relationsBySource: ReadonlyMap<string, ReadonlyArray<string>>,
): DecisionClaim {
  const ref = `decision/${decisionId}/${id}`;
  return {
    id,
    text,
    evidence: [...new Set(relationsBySource.get(ref) ?? [])],
  };
}

/**
 * Kernel decision states pass through; anything else is unknown — never a plausible
 * neighbour (ADR-0020 D1: `superseded` is not "awaiting approval").
 */
const kernelDecisionStates: ReadonlySet<string> = new Set([
  "proposed",
  "rejected",
  "deferred",
  "superseded",
  "in_effect",
  "outcome_retired",
]);
function decisionState(value: string): DecisionState {
  return kernelDecisionStates.has(value) ? (value as DecisionState) : "unknown";
}
function actorRef(value: DecisionProjectionRow["proposer"]): { readonly kind: "agent" | "human"; readonly id: string } {
  return value.executor ? { kind: "agent", id: value.executor.id } : { kind: "human", id: value.principal.personId };
}

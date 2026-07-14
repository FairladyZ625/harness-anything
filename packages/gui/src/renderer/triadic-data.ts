import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DecisionMutationResult,
  DecisionProjectionRow,
  FactProjectionRow,
  RelationCoverageRow,
  RelationGraphEdgeRow
} from "../api/renderer-dto.ts";
import { harnessClient } from "./api-client.ts";
import type { DecisionListSuccess, FactListSuccess, RelationGraphSuccess } from "./api-client.ts";
import { KIND_LABEL } from "./graph/constants.ts";
import type { DecisionClaim, DecisionRow, DecisionState, FactRef, RelationEdge } from "./model/types.ts";

export const triadicQueryKeys = {
  all: ["harness", "triadic"] as const,
  snapshot: () => [...triadicQueryKeys.all, "snapshot"] as const
};

export type DecideAction = "accept" | "reject" | "defer";

export interface DecideMutationInput {
  readonly decisionId: string;
  readonly action: DecideAction;
  /** Required non-empty for reject; optional for defer; ignored for accept. */
  readonly judgmentOnlyRationale?: string;
}

/**
 * Accept / reject / defer a proposed decision through the existing renderer API.
 *
 * Identity/actor is NOT passed from the renderer — the daemon derives the principal
 * from the unix-socket owner. Do not inject HARNESS_ACTOR or any principal field.
 */
export function useDecideMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: DecideMutationInput): Promise<DecisionMutationResult> => {
      const payload = {
        decisionId: input.decisionId,
        ...(input.judgmentOnlyRationale
          ? { judgmentOnlyRationale: input.judgmentOnlyRationale }
          : {}),
      };
      let result: DecisionMutationResult;
      if (input.action === "accept") {
        result = await harnessClient.acceptDecision(payload);
      } else if (input.action === "reject") {
        result = await harnessClient.rejectDecision(payload);
      } else {
        result = await harnessClient.deferDecision(payload);
      }
      if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.hint}`);
      }
      return result;
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: triadicQueryKeys.all });
    },
  });
}

export function useTriadicProjectionQuery() {
  const snapshot = useQuery({
    queryKey: triadicQueryKeys.snapshot(),
    queryFn: () => harnessClient.getTriadicProjection(),
    staleTime: 10_000
  });

  const rendererData = buildTriadicRendererData({
    graph: snapshot.data ?? emptyTriadicSnapshot,
    decisions: snapshot.data ?? emptyTriadicSnapshot,
    factResults: snapshot.data ? [snapshot.data] : []
  });

  return {
    isLoading: snapshot.isLoading,
    isError: snapshot.isError,
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
  readonly factResults: ReadonlyArray<Pick<FactListSuccess, "facts">>;
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

const emptyTriadicSnapshot: RelationGraphSuccess & DecisionListSuccess & FactListSuccess = {
  ok: true,
  edges: [],
  coverageRows: [],
  factAnchors: [],
  decisions: [],
  facts: [],
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

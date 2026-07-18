import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DecisionMutationResult,
  DecisionProjectionRow,
  FactProjectionRow,
  RelationCoverageRow,
  RelationGraphEdgeRow
} from "../api/renderer-dto.ts";
import type { DecisionProposePayload } from "../api/renderer-dto.ts";
import { harnessClient } from "./api-client.ts";
import type { DecisionListSuccess, FactListSuccess, RelationGraphSuccess } from "./api-client.ts";
import { KIND_LABEL } from "./graph/constants.ts";
import type { DecisionClaim, DecisionRow, DecisionState, FactRef, RelationEdge } from "./model/types.ts";

export const triadicQueryKeys = {
  all: ["harness", "triadic"] as const,
  snapshot: (repoId?: string | null) =>
    [...triadicQueryKeys.all, "snapshot", repoId ?? "default"] as const
};

export type DecideAction = "accept" | "reject" | "defer";

export interface DecideMutationInput {
  readonly decisionId: string;
  readonly action: DecideAction;
  /** Required non-empty for judgment-only accept/reject; optional for defer. */
  readonly judgmentOnlyRationale?: string;
}

/**
 * Accept / reject / defer a proposed decision through the existing renderer API.
 *
 * Identity/actor is NOT passed from the renderer — the daemon derives the principal
 * from the unix-socket owner. Do not inject HARNESS_ACTOR or any principal field.
 */
export function useDecideMutation(repoId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: DecideMutationInput): Promise<DecisionMutationResult> => {
      const payload = {
        decisionId: input.decisionId,
        ...(input.judgmentOnlyRationale
          ? { judgmentOnlyRationale: input.judgmentOnlyRationale }
          : {}),
        ...(repoId ? { repoId } : {})
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

/**
 * Renderer-side shape for a single chosen option entry in a decision proposal.
 * Mirrors the daemon `DecisionChoicePayload` minus the server-assigned `id`
 * (anchor ids come back in the projection, not the form).
 */
export interface DecisionProposeChosenInput {
  readonly text: string;
}

/**
 * Renderer-side shape for a rejected option entry. `whyNot` is required by the
 * daemon validator (gui-route-payload.ts:validRejected) — the form enforces
 * non-blank before submit so the user sees the gate ahead of IPC.
 */
export interface DecisionProposeRejectedInput extends DecisionProposeChosenInput {
  readonly whyNot: string;
}

/**
 * Renderer-side shape for an authored claim. Daemon-side `DecisionProposePayload`
 * lists claims as optional, but the kernel decision-package/v1 downstream requires
 * at least one claim, so the form treats claims as required (dec_01KXARBFDR).
 */
export interface DecisionProposeClaimInput extends DecisionProposeChosenInput {
  readonly fulfillment?: "evidenced" | "delivered" | "standing-policy";
}

/**
 * Form-level proposal input. The hook adapts this into the daemon DTO
 * (`DecisionProposePayload`) — keeps the form component free of camelCase ⇄
 * snake_case translation noise and gives tests a single conversion seam.
 */
export interface DecisionProposeInput {
  readonly title: string;
  readonly question: string;
  readonly chosen: ReadonlyArray<DecisionProposeChosenInput>;
  readonly rejected: ReadonlyArray<DecisionProposeRejectedInput>;
  readonly claims: ReadonlyArray<DecisionProposeClaimInput>;
  readonly riskTier: "low" | "medium" | "high";
  readonly urgency: "low" | "medium" | "high";
  readonly modules?: ReadonlyArray<string>;
  readonly productLines?: ReadonlyArray<string>;
  readonly body?: string;
  readonly decisionId?: string;
}

/**
 * Build the daemon payload from form input. Pure so unit tests can pin the
 * camelCase → snake_case boundary without mounting React.
 *
 * Identity/actor is NOT injected — same authority boundary as `useDecideMutation`.
 */
export function buildDecisionProposePayload(input: DecisionProposeInput): DecisionProposePayload {
  const payload: {
    title: string;
    question: string;
    chosen: ReadonlyArray<{ text: string }>;
    rejected: ReadonlyArray<{ text: string; why_not: string }>;
    claims: ReadonlyArray<{ text: string; fulfillment?: "evidenced" | "delivered" | "standing-policy" }>;
    riskTier: "low" | "medium" | "high";
    urgency: "low" | "medium" | "high";
    decisionId?: string;
    body?: string;
    modules?: ReadonlyArray<string>;
    productLines?: ReadonlyArray<string>;
  } = {
    title: input.title,
    question: input.question,
    chosen: input.chosen.map((entry) => ({ text: entry.text })),
    rejected: input.rejected.map((entry) => ({ text: entry.text, why_not: entry.whyNot })),
    claims: input.claims.map((entry) => ({
      text: entry.text,
      ...(entry.fulfillment ? { fulfillment: entry.fulfillment } : {})
    })),
    riskTier: input.riskTier,
    urgency: input.urgency
  };
  if (input.decisionId) payload.decisionId = input.decisionId;
  if (input.body) payload.body = input.body;
  if (input.modules && input.modules.length > 0) payload.modules = [...input.modules];
  if (input.productLines && input.productLines.length > 0) payload.productLines = [...input.productLines];
  return payload;
}

/**
 * Propose a new decision via the daemon IPC write port (dec_01KXARBFDR).
 *
 * Accepts the already-built daemon payload (`DecisionProposePayload`). The
 * form composes the payload via `buildDecisionProposePayload` so this hook
 * stays a thin IPC wrapper. Renders surface failures verbatim (`code: hint`)
 * — the form's error banner shows the daemon's exact code/hint pair, no
 * rewriting or swallowing.
 */
export function useProposeDecisionMutation(repoId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: DecisionProposePayload): Promise<DecisionMutationResult> => {
      const result = await harnessClient.proposeDecision({
        ...payload,
        ...(repoId ? { repoId } : {})
      });
      if (!result.ok) {
        // Preserve code/hint verbatim so the receipt is honest — the consumer
        // can read `.error` directly without re-parsing the thrown message.
        const err = result as { ok: false; error: { code: string; hint: string } };
        throw new ProposeDecisionError(err.error.code, err.error.hint);
      }
      return result;
    },
    onSettled: async () => {
      // Refresh the triadic projection so the new proposed decision lands in
      // the pool, graph, and sidebar inbox badge in one shot.
      await queryClient.invalidateQueries({ queryKey: triadicQueryKeys.all });
    }
  });
}

/**
 * Dedicated error class so the form can recover code/hint without string
 * parsing. `message` keeps the `${code}: ${hint}` convention used elsewhere.
 */
export class ProposeDecisionError extends Error {
  readonly code: string;
  readonly hint: string;
  constructor(code: string, hint: string) {
    super(`${code}: ${hint}`);
    this.name = "ProposeDecisionError";
    this.code = code;
    this.hint = hint;
  }
}

export function useTriadicProjectionQuery(repoId?: string | null) {
  const snapshot = useQuery({
    queryKey: triadicQueryKeys.snapshot(repoId),
    queryFn: () => harnessClient.getTriadicProjection(repoId ?? undefined),
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

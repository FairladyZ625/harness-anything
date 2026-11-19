import type * as Coverage from "../domain/decision-coverage.ts";
import type { relationStates } from "../domain/relation-state.ts";

import type { SessionProvenanceV1 } from "../domain/agent-runtime.ts";
import {
  decisionAcceptReviewReadiness,
  decisionReviewContentDigest,
  type DecisionAcceptReviewReadiness,
  type DecisionAmendmentV1,
  type DecisionContentPinV1,
  type DecisionDocumentState,
  type DecisionFulfillmentMode,
  type DecisionJudgmentConsentV1,
  type DecisionRelationLinkResolver,
  type DecisionState,
} from "../domain/decision-event.ts";
import { parseEntityRef } from "../domain/entity-ref.ts";
import type { EntityRelationRecord } from "../domain/entity-relation.ts";
import type { DecisionReviewRequirement } from "../domain/settings.ts";
import type { ActorIdentity } from "../domain/write-chain.contract.ts";
import type { EntityVersion, RelationFreshness } from "../domain/entity-freshness.ts";
import type { DecisionReadinessProjection } from "./projection-contracts.ts";
import type { DecisionCapability } from "../domain/decision-board-projection.ts";
import type { TaskProjection } from "./task-projection.ts";

export interface DecisionBodyRow {
  readonly path: string;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly body: string;
  readonly workspaceRevision: number;
}

export interface DecisionProjectionRow {
  readonly schema: "decision-row/v1";
  readonly decisionId: string;
  readonly legacyId?: string;
  readonly path: string;
  readonly state: DecisionState;
  readonly title: string;
  readonly question: string;
  readonly riskTier: "low" | "medium" | "high";
  readonly urgency: "low" | "medium" | "high";
  readonly vertical: string;
  readonly preset: string;
  readonly decisionClass: "ordinary" | "standing_policy";
  readonly appliesTo: {
    readonly modules: readonly string[];
    readonly productLines: readonly string[];
  };
  readonly proposer: ActorIdentity;
  readonly arbiter: ActorIdentity | null;
  readonly proposedAt: string;
  readonly decidedAt: string | null;
  readonly workspaceRevision: number;
  readonly chosen: readonly {
    readonly id: string;
    readonly text: string;
    readonly rationale?: string;
  }[];
  readonly rejected: readonly {
    readonly id: string;
    readonly text: string;
    readonly whyNot: string;
  }[];
  readonly claims: readonly {
    readonly id: string;
    readonly text: string;
    readonly loadBearing: boolean;
    readonly fulfillment: DecisionFulfillmentMode | null;
  }[];
  readonly provenance: readonly SessionProvenanceV1[];
  readonly judgmentConsents: readonly DecisionJudgmentConsentV1[];
  readonly reviews: DecisionDocumentState["reviews"];
  readonly reviewResponses: DecisionDocumentState["reviewResponses"];
  readonly reviewOverrides: DecisionDocumentState["reviewOverrides"];
  readonly relations: DecisionDocumentState["relations"];
  readonly amendments?: readonly DecisionAmendmentV1[];
  readonly contentPins?: readonly DecisionContentPinV1[];
  readonly body: DecisionBodyRow | null;
  readonly readiness?: DecisionReadinessProjection;
  readonly capabilities: readonly DecisionCapability[];
  readonly claimsOpen: boolean;
  readonly materializationState?: import("../domain/entity-relation.ts").CanonicalMaterializationState;
}

export type DecisionAgendaProjectionRow = Pick<
  DecisionProjectionRow,
  "decisionId" | "title" | "riskTier" | "urgency" | "proposedAt"
>;

export interface DecisionPageQuery {
  readonly state: DecisionState;
  readonly limit?: number;
  readonly cursor?: string;
}

export const DEFAULT_DECISION_LIST_PAGE_SIZE = 100;

export interface DecisionListFilters {
  readonly withBody?: boolean;
  readonly search?: string;
  readonly legacyId?: string;
  readonly legacyRange?: { readonly start: number; readonly end: number };
  readonly state?: DecisionState;
  readonly module?: string;
  readonly productLine?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface DecisionAnchorRow {
  readonly decisionRef: string;
  readonly decisionId: string;
  readonly anchorRefs: readonly string[];
  readonly sourcePath: string;
}

export interface DecisionRelationEdgeRow {
  readonly relationId: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: EntityRelationRecord["type"];
  readonly direction: EntityRelationRecord["direction"];
  readonly strength: EntityRelationRecord["strength"];
  readonly origin: EntityRelationRecord["origin"];
  readonly state: (typeof relationStates)[number];
  readonly targetObservedVersion: EntityVersion | null;
  readonly currentTargetVersion: EntityVersion | null;
  readonly freshness: RelationFreshness;
  readonly rationale: string;
  readonly ownerRef: string;
  readonly sourcePath: string;
  readonly recordIndex: number;
  readonly retiredRevision?: number;
  readonly retiredAt?: string;
  readonly retirementReason?: string;
}

export interface DecisionCoverageRow {
  readonly decisionRef: string;
  readonly claimRef: string;
  readonly status: Coverage.CoverageResult["status"];
  readonly covered: boolean;
  readonly fulfillment: DecisionFulfillmentMode | null;
  readonly coveringFactRef?: string;
  readonly refutingFactRefs: readonly string[];
  readonly relationPath: readonly string[];
  readonly basisRevision: number;
}

/** Resolves one relation endpoint to the current canonical document path and a one-line label. */
export function decisionRelationLinkResolver(
  projection: Pick<TaskProjection, "readDecision" | "readFact" | "read">,
): DecisionRelationLinkResolver {
  const label = (text: string) => text.replace(/\s+/gu, " ").trim();
  return (ref) => {
    const parsed = parseEntityRef(ref);
    if (!parsed) return null;
    if (parsed.kind === "decision") {
      const decision = projection.readDecision(parsed.id).decision;
      return decision === null
        ? null
        : { path: `decisions/decision-${parsed.id}/decision.md`, label: label(decision.title) };
    }
    if (parsed.kind === "fact") {
      const fact = projection.readFact(parsed.id).fact;
      return fact === null ? null : { path: `facts/${parsed.id}.md`, label: label(fact.statement) };
    }
    if (parsed.kind === "task") {
      const read = projection.read(parsed.id);
      return read.packagePath === null || read.snapshot.task === null
        ? null
        : { path: `${read.packagePath}/INDEX.md`, label: label(read.snapshot.task.title) };
    }
    return null;
  };
}

/**
 * The review cut and accept readiness derived from Decision projection + review requirement.
 */
export function decisionReviewState(
  row: DecisionProjectionRow,
  requirement: DecisionReviewRequirement,
): {
  readonly currentReviewContentDigest: `sha256:${string}` | null;
  readonly acceptReviewReadiness: DecisionAcceptReviewReadiness | null;
} {
  if (row.body === null) return { currentReviewContentDigest: null, acceptReviewReadiness: null };
  const digest = decisionReviewContentDigest(row, row.body.body);
  return {
    currentReviewContentDigest: digest,
    acceptReviewReadiness:
      row.state === "proposed" ? decisionAcceptReviewReadiness(row, row.body.body, requirement) : null,
  };
}

/**
 * The canonical rationale for the awaits edge telling a proposal owner about unresolved review changes.
 */
export function decisionReviewAwaitRationale(decisionId: string): string {
  return `consent: Decision ${decisionId} has review changes to resolve.`;
}

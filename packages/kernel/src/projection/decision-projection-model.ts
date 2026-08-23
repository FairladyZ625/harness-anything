import type { SessionProvenanceV1 } from "../domain/agent-runtime.ts";
import type {
  DecisionAmendmentV1,
  DecisionContentPinV1,
  DecisionFulfillmentMode,
  DecisionJudgmentConsentV1,
  DecisionState,
} from "../domain/decision-event.ts";
import type { EntityRelationRecord } from "../domain/entity-relation.ts";
import type { ActorIdentity } from "../domain/write-chain.contract.ts";
import type { DecisionReadinessProjection } from "./decision-readiness-projection.ts";

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
  readonly amendments?: readonly DecisionAmendmentV1[];
  readonly contentPins?: readonly DecisionContentPinV1[];
  readonly body: DecisionBodyRow | null;
  readonly readiness?: DecisionReadinessProjection;
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

export interface DecisionListFilters {
  readonly search?: string;
  readonly legacyId?: string;
  readonly legacyRange?: { readonly start: number; readonly end: number };
  readonly state?: DecisionState;
  readonly module?: string;
  readonly productLine?: string;
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
  readonly state: "active" | "edge_retired";
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
  readonly status: "covered" | "uncovered";
  readonly fulfillment: DecisionFulfillmentMode | null;
  readonly coveringFactRef?: string;
  readonly refutingFactRefs: readonly string[];
  readonly relationPath: readonly string[];
  readonly basisRevision: number;
}

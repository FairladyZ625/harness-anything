import { type SessionProvenanceV1 } from "./agent-runtime.ts";
import { type EntityRelationRecord } from "./entity-relation.ts";
import { type ActorIdentity, type EventEnvelope, type FrozenWritePlan } from "./write-chain.contract.ts";

export const decisionEventTypes = [
  "decision_proposed",
  "decision_accepted",
  "decision_rejected",
  "decision_deferred",
  "decision_superseded",
  "decision_retired",
  "decision_amended",
  "decision_repinned",
  "decision_claim_declared",
  "decision_claim_fulfillment_declared",
  "decision_related",
  "decision_relation_retired",
  "decision_relation_replaced",
] as const;
export const decisionStates = [
  "proposed",
  "in_effect",
  "rejected",
  "deferred",
  "superseded",
  "outcome_retired",
] as const;
export const policyStates = ["draft", "active", "retired"] as const;
export type PolicyState = (typeof policyStates)[number];
export const decisionFulfillmentModes = ["evidenced", "delivered", "standing_policy"] as const;
export type DecisionState = (typeof decisionStates)[number];
export type DecisionFulfillmentMode = (typeof decisionFulfillmentModes)[number];
export interface DecisionProposalPayload {
  readonly title: string;
  readonly question: string;
  readonly riskTier: "low" | "medium" | "high";
  readonly urgency: "low" | "medium" | "high";
  readonly vertical: string;
  readonly preset: string;
  readonly appliesTo: {
    readonly modules: readonly string[];
    readonly productLines: readonly string[];
  };
  readonly decisionClass: "ordinary" | "standing_policy";
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
  readonly body: string;
  readonly claims: readonly {
    readonly id: string;
    readonly text: string;
    readonly loadBearing: boolean;
  }[];
  readonly fulfillments: readonly {
    readonly claimId: string;
    readonly mode: DecisionFulfillmentMode;
  }[];
  readonly relations: readonly EntityRelationRecord[];
  readonly provenance: readonly SessionProvenanceV1[];
}
export interface DecisionAmendableSnapshot {
  readonly title: string;
  readonly decisionClass: "ordinary" | "standing_policy";
  readonly chosen: DecisionProposalPayload["chosen"];
  readonly rejected: DecisionProposalPayload["rejected"];
  readonly claims: readonly {
    readonly id: string;
    readonly text: string;
    readonly loadBearing: boolean;
    readonly fulfillment: DecisionFulfillmentMode | null;
  }[];
}
export interface DecisionAmendmentV1 {
  readonly schema: "decision-amendment/v1";
  readonly amendmentId: string;
  readonly fields: readonly string[];
  readonly actor: ActorIdentity;
  readonly amendedAt: string;
}
export interface DecisionContentPinV1 {
  readonly schema: "decision-content-pin/v1";
  readonly pinId: string;
  readonly action: "accept" | "reject" | "defer" | "supersede" | "retire" | "amend" | "repin";
  readonly state: DecisionState;
  readonly pinnedAt: string;
  readonly evidence: string;
  readonly actor: ActorIdentity;
  readonly digest: `sha256:${string}`;
}
export interface DecisionPayloads {
  readonly decision_proposed: DecisionProposalPayload;
  readonly decision_accepted: {
    readonly rationale: string;
    readonly judgmentOnlyRationale: string | null;
    readonly fulfillments?: readonly {
      readonly claimId: string;
      readonly mode: DecisionFulfillmentMode;
    }[];
    readonly standingPolicy?: boolean;
  };
  readonly decision_rejected: { readonly reason: string };
  readonly decision_deferred: { readonly reason: string };
  readonly decision_superseded: { readonly reason: string };
  readonly decision_retired: { readonly reason: string };
  readonly decision_amended: {
    readonly next: DecisionAmendableSnapshot;
    readonly fields: readonly string[];
    readonly body: string | null;
  };
  readonly decision_repinned: { readonly migrationEvidence: string };
  readonly decision_claim_declared: {
    readonly claimId: string;
    readonly text: string;
    readonly loadBearing: boolean;
  };
  readonly decision_claim_fulfillment_declared: {
    readonly claimId: string;
    readonly mode: DecisionFulfillmentMode;
  };
  readonly decision_related: { readonly relation: EntityRelationRecord };
  readonly decision_relation_retired: {
    readonly relationId: string;
    readonly reason: string;
  };
  readonly decision_relation_replaced: {
    readonly relationId: string;
    readonly reason: string;
    readonly replacement: EntityRelationRecord;
    readonly body: string | null;
  };
}
export type DecisionJudgmentAction = "accept" | "reject" | "defer";
export interface DecisionJudgmentConsentV1 {
  readonly schema: "decision-judgment-consent/v1";
  readonly consentId: string;
  readonly decisionId: string;
  readonly action: DecisionJudgmentAction;
  readonly targetState: "in_effect" | "rejected" | "deferred";
  readonly machineDigest: `sha256:${string}`;
  readonly actor: ActorIdentity;
  readonly source: DecisionEventDraftV1["source"];
  readonly consentedAt: string;
}
export const DECISION_DOCUMENT_POLICY_ID = "markdown-body-replaceable/v1" as const;
export interface DecisionDocumentClaim {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "text/markdown";
  readonly policyId: typeof DECISION_DOCUMENT_POLICY_ID;
}
export interface DecisionDocumentMutation {
  readonly baseDocumentSha256: string | null;
  readonly decisionDocumentClaim: DecisionDocumentClaim;
}
export type DecisionEventDraftV1 = {
  [T in keyof DecisionPayloads]: EventEnvelope<"decision-event/v1", T, ActorIdentity, DecisionPayloads[T]> & {
    readonly decisionId: string;
  };
}[keyof DecisionPayloads];
export type DecisionOutcomeType = "decision_accepted" | "decision_rejected" | "decision_deferred";
export type DecisionTransitionType = DecisionOutcomeType | "decision_superseded" | "decision_retired";
type DecisionPublishedPayload<T extends keyof DecisionPayloads> = DecisionPayloads[T] &
  DecisionDocumentMutation &
  (T extends DecisionOutcomeType ? { readonly judgmentConsent: DecisionJudgmentConsentV1 } : object) &
  (T extends DecisionTransitionType | "decision_repinned"
    ? { readonly contentPin?: DecisionContentPinV1 }
    : T extends "decision_amended"
      ? { readonly contentPin: DecisionContentPinV1 }
      : object) &
  (T extends "decision_amended" ? { readonly amendment: DecisionAmendmentV1 } : object);
export type DecisionEventV1 = {
  [T in keyof DecisionPayloads]: EventEnvelope<"decision-event/v1", T, ActorIdentity, DecisionPublishedPayload<T>> & {
    readonly decisionId: string;
  };
}[keyof DecisionPayloads];
export interface DecisionDocumentState {
  readonly decisionId: string;
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
  readonly chosen: DecisionProposalPayload["chosen"];
  readonly rejected: DecisionProposalPayload["rejected"];
  readonly claims: readonly {
    readonly id: string;
    readonly text: string;
    readonly loadBearing: boolean;
    readonly fulfillment: DecisionFulfillmentMode | null;
  }[];
  readonly relations: readonly EntityRelationRecord[];
  readonly provenance: readonly SessionProvenanceV1[];
  readonly judgmentConsents: readonly DecisionJudgmentConsentV1[];
  readonly amendments?: readonly DecisionAmendmentV1[];
  readonly contentPins?: readonly DecisionContentPinV1[];
}
export interface DecisionContentBlob {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "text/markdown";
  readonly body: string;
}
export interface CompiledDecisionWrite {
  readonly event: DecisionEventV1;
  readonly plan: FrozenWritePlan<"DecisionWrite">;
  readonly blobs: readonly [DecisionContentBlob];
  readonly path: string;
  readonly body: string;
}

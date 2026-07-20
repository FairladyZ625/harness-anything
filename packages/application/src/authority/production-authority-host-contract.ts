import type {
  ConsentAction,
  DecisionClaimFulfillment,
  DecisionPackage,
  DomainStatus,
  EntityRelationRecord,
  FactMemoryClass,
  FactMemoryTag,
  HarnessLayoutInput,
  HarnessLayoutOverrides,
  PriorityTier,
  ProvenancePayload,
  RelationType,
  ReviewVerdict,
  TaskWorkKind
} from "@harness-anything/kernel";
import type { DecisionCreateInput } from "../decision-write-service.ts";

export interface ProductionAuthorityEvidenceInput {
  readonly type: string;
  readonly path: string;
  readonly summary: string;
}

export interface ProductionAuthorityDecisionChoiceInput {
  readonly id?: string;
  readonly text: string;
  readonly load_bearing?: boolean;
}

export interface ProductionAuthorityDecisionRejectedInput {
  readonly id?: string;
  readonly text: string;
  readonly why_not?: string;
}

export interface ProductionAuthorityDecisionClaimInput {
  readonly id?: string;
  readonly text: string;
  readonly load_bearing?: boolean;
  readonly fulfillment?: DecisionClaimFulfillment;
}

export interface ProductionAuthorityDecisionClaimFulfillmentInput {
  readonly claimId: string;
  readonly fulfillment: DecisionClaimFulfillment;
}

export interface ProductionAuthorityDecisionEvidenceRelationInput {
  readonly anchor: string;
  readonly type: RelationType;
  readonly target: string;
  readonly rationale: string;
}

export type ProductionAuthorityNewTaskAction = {
  readonly kind: "new-task";
  readonly taskId?: string;
  readonly title: string;
  readonly parent?: string;
  readonly slug: string;
  readonly allowManualId: boolean;
  readonly fromLegacyId?: string;
  readonly workKind?: TaskWorkKind;
  readonly riskTier?: PriorityTier;
  readonly urgency?: PriorityTier;
  readonly vertical?: string;
  readonly preset?: string;
  readonly profile?: string;
  readonly moduleKey?: string;
  readonly registerModule?: { readonly key: string; readonly title: string; readonly prefix?: string; readonly scope: string };
  readonly longRunning: boolean;
  readonly dryRun: boolean;
  readonly locale?: "zh-CN" | "en-US";
};

export type ProductionAuthorityDecisionProposeAction = {
  readonly kind: "decision-propose";
  readonly decisionId: string;
  readonly decisionIdProvided?: boolean;
  readonly proposedAt: string;
  readonly title: string;
  readonly question: string;
  readonly chosen: ReadonlyArray<ProductionAuthorityDecisionChoiceInput>;
  readonly rejected: ReadonlyArray<ProductionAuthorityDecisionRejectedInput>;
  readonly claim?: string;
  readonly claims: ReadonlyArray<ProductionAuthorityDecisionClaimInput>;
  readonly claimLoadBearing: boolean;
  readonly fulfillments: ReadonlyArray<ProductionAuthorityDecisionClaimFulfillmentInput>;
  readonly riskTier: "low" | "medium" | "high";
  readonly urgency: "low" | "medium" | "high";
  readonly modules: ReadonlyArray<string>;
  readonly productLines: ReadonlyArray<string>;
  readonly evidenceRelations: ReadonlyArray<ProductionAuthorityDecisionEvidenceRelationInput>;
  readonly body?: string;
  readonly dryRun: boolean;
};

export type ProductionAuthorityCommandAction =
  | ProductionAuthorityNewTaskAction
  | { readonly kind: "task-claim"; readonly taskId: string; readonly executionId?: string }
  | { readonly kind: "status-set"; readonly taskId: string; readonly status: DomainStatus; readonly force: boolean; readonly reason?: string; readonly executionSubmission?: { readonly executionId?: string; readonly leaseToken?: string; readonly completionClaim: string; readonly deliverables: ReadonlyArray<string>; readonly verificationNotes: ReadonlyArray<string>; readonly knownGaps: ReadonlyArray<string>; readonly residualRisks: ReadonlyArray<string>; readonly outputs: ReadonlyArray<string> } }
  | { readonly kind: "progress-append"; readonly taskId: string; readonly text: string; readonly evidence?: ReadonlyArray<ProductionAuthorityEvidenceInput> }
  | { readonly kind: "task-amend"; readonly taskId: string; readonly patches: ReadonlyArray<{ readonly field: string; readonly value: string }> }
  | { readonly kind: "task-archive"; readonly taskId?: string; readonly ids?: ReadonlyArray<string>; readonly reason: string }
  | { readonly kind: "task-supersede"; readonly oldTaskId: string; readonly byTaskId?: string }
  | { readonly kind: "task-delete"; readonly taskId: string; readonly mode: "soft" | "hard"; readonly reason: string }
  | { readonly kind: "task-reopen"; readonly taskId: string; readonly reason: string }
  | { readonly kind: "task-code-doc-reconcile"; readonly taskId: string; readonly sha: string; readonly paths: ReadonlyArray<string>; readonly prRef?: string; readonly force: boolean }
  | { readonly kind: "task-consent-record"; readonly taskId: string; readonly executionId: string; readonly utterance?: string; readonly standingPolicyDecisionId?: string; readonly assertedRationale?: string; readonly consentActions: ReadonlyArray<ConsentAction> }
  | { readonly kind: "task-review-execution"; readonly taskId: string; readonly executionId?: string; readonly verdict: ReviewVerdict; readonly findings: string; readonly evidenceChecked: ReadonlyArray<string>; readonly rationale: string; readonly archiveWarningsAcknowledged: boolean; readonly consentId?: string; readonly generatedConsentId?: string; readonly consentUtterance?: string; readonly consentStandingPolicyDecisionId?: string; readonly consentAssertedRationale?: string; readonly consentActions?: ReadonlyArray<ConsentAction> }
  | { readonly kind: "task-complete"; readonly taskId: string }
  | { readonly kind: "task-relate"; readonly sourceTaskId: string; readonly relationType: "depends-on"; readonly targetTaskId: string; readonly rationale: string }
  | ProductionAuthorityDecisionProposeAction
  | { readonly kind: "decision-transition"; readonly transition: "accept" | "reject" | "defer" | "supersede" | "retire"; readonly decisionId: string }
  | { readonly kind: "decision-amend"; readonly decisionId: string }
  | { readonly kind: "decision-relate"; readonly decisionId: string; readonly anchor: string; readonly relationType: RelationType; readonly target: string; readonly rationale: string }
  | { readonly kind: "decision-relation-retire"; readonly decisionId: string; readonly relationId: string }
  | { readonly kind: "decision-relation-replace"; readonly decisionId: string; readonly relationId: string }
  | { readonly kind: "record-fact"; readonly taskId: string; readonly factId: string; readonly factIdProvided?: boolean; readonly statement: string; readonly source?: string; readonly observedAt: string; readonly confidence: "low" | "medium" | "high"; readonly memoryClass: FactMemoryClass; readonly memoryTags: ReadonlyArray<FactMemoryTag>; readonly dryRun: boolean }
  | { readonly kind: "fact-invalidate"; readonly taskId: string; readonly factId: string; readonly invalidatedByFactId: string; readonly rationale: string }
  | { readonly kind: "session-export"; readonly sessionId?: string; readonly runtime?: "claude-code" | "codex" | "zcode" | "antigravity"; readonly source?: "runtime" | "manual"; readonly detectedAt?: string; readonly user?: string; readonly transcriptFile?: string }
  | { readonly kind: "preset-entrypoint"; readonly presetId: string; readonly taskId: string }
  | { readonly kind: "script-run"; readonly scriptId: string; readonly taskId?: string }
  | { readonly kind: "module-register"; readonly moduleKey: string; readonly title: string; readonly scope: string; readonly prefix?: string; readonly status?: string; readonly branch?: string; readonly owner?: string; readonly currentStep?: string; readonly shared: ReadonlyArray<string>; readonly dependsOn: ReadonlyArray<string> }
  | { readonly kind: "module-unregister"; readonly moduleKey: string }
  | { readonly kind: "module-step"; readonly moduleKey: string; readonly stepId: string; readonly state: "planned" | "in-progress" | "blocked" | "done" };

/** Normalized command data consumed by production authority; CLI grammar remains CLI-owned. */
export interface ProductionAuthorityCommand {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly action: ProductionAuthorityCommandAction;
}

export type ProductionAuthorityIngressAdapter = "generic" | "decision-transition" | "task-claim" | "observed-write";

export type ProductionAuthorityIngressDisposition =
  | { readonly status: "typed-v2"; readonly adapter: ProductionAuthorityIngressAdapter }
  | { readonly status: "excluded"; readonly decisionRef: string; readonly reason: string };

export interface ProductionAuthorityTaskCreateWrite {
  readonly path: string;
  readonly body: string;
  readonly packageSlug?: string;
}

export interface ProductionAuthorityCompilerHostServices {
  readonly productionAuthorityIngressFor: (kind: string) => ProductionAuthorityIngressDisposition | undefined;
  readonly productionAuthorityUnsupportedHint: (rejectedKind: string) => string;
  readonly normalizeDecisionProposeAction: (action: ProductionAuthorityDecisionProposeAction) => ProductionAuthorityDecisionProposeAction;
  readonly normalizedFactSource: (action: Extract<ProductionAuthorityCommandAction, { readonly kind: "record-fact" }>) => string;
  readonly buildTaskCreateWrites: (input: {
    readonly rootInput: HarnessLayoutInput;
    readonly action: ProductionAuthorityNewTaskAction;
    readonly createdAt: string;
    readonly provenance: ProvenancePayload;
  }) =>
    | { readonly ok: true; readonly writes: ReadonlyArray<ProductionAuthorityTaskCreateWrite> }
    | { readonly ok: false; readonly settingsErrorCode?: string };
  readonly materializeProposedDecision: (action: ProductionAuthorityDecisionProposeAction) =>
    | { readonly ok: true; readonly decision: DecisionCreateInput }
    | { readonly ok: false; readonly reason: string };
  readonly decisionRelationRecord: (input: {
    readonly decisionId: string;
    readonly anchor: string;
    readonly target: string;
    readonly relationType: EntityRelationRecord["type"];
    readonly rationale: string;
  }) => EntityRelationRecord;
  readonly materializedTaskPriorityWrites: (
    rootInput: HarnessLayoutInput,
    decision: DecisionPackage,
    relation: EntityRelationRecord
  ) =>
    | { readonly ok: true; readonly writes: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly body: string }> }
    | { readonly ok: false; readonly error: { readonly hint: string } };
  readonly renderForceStatusAudit: (status: string, reason: string, recordedAt?: string) => string;
}

export interface ProductionAuthorityIdentityHostService<Identity> {
  readonly loadDaemonIdentity: (
    rootDir: string,
    layoutOverrides: { readonly authoredRoot?: string } | undefined,
    endpoint?: string,
    userRoot?: string
  ) => Identity;
}

export type ProductionAuthorityHostServices<Identity> =
  & ProductionAuthorityCompilerHostServices
  & ProductionAuthorityIdentityHostService<Identity>;

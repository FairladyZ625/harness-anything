import type { DecisionPackage, EntityRelationRecord } from "@harness-anything/kernel";

export interface TaskCreatePayloadV2 {
  readonly schema: "task.create/v1";
  readonly taskId: string;
  readonly packageSlug?: string;
  readonly indexBody: string;
  readonly writes?: ReadonlyArray<{
    readonly path: string;
    readonly body: string;
    readonly packageSlug?: string;
  }>;
}

export interface TaskTransitionPayloadV2 {
  readonly schema: "task.transition/v1";
  readonly taskId: string;
  readonly to: string;
  readonly auditText?: string;
  readonly completionContractBodySha256?: string | null;
}

export interface TaskAppendPayloadV2 {
  readonly schema: "task.append/v1";
  readonly taskId: string;
  readonly text: string;
}

export interface TaskDocumentPayloadV2 {
  readonly schema: "task.document/v1";
  readonly taskId: string;
  readonly path: string;
  readonly body: string;
  readonly historyDocumentSetSha256?: string;
}

export interface TaskAmendPayloadV2 {
  readonly schema: "task.amend/v1";
  readonly taskId: string;
  readonly fields: ReadonlyArray<string>;
  readonly body: string;
}

export interface TaskArchivePayloadV2 {
  readonly schema: "task.archive/v1";
  readonly taskId: string;
  readonly reason: string;
  readonly body: string;
}

export interface TaskSupersedePayloadV2 {
  readonly schema: "task.supersede/v1";
  readonly taskId: string;
  readonly body?: string;
  readonly replacementTaskId?: string;
  readonly writes?: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly body: string; readonly packageSlug?: string }>;
}

export interface TaskDeletePayloadV2 {
  readonly schema: "task.delete/v1";
  readonly taskId: string;
  readonly mode: "soft";
  readonly reason: string;
  readonly body: string;
}

export interface TaskReopenPayloadV2 {
  readonly schema: "task.reopen/v1";
  readonly taskId: string;
  readonly reason: string;
  readonly body: string;
}

export interface TaskRelatePayloadV2 {
  readonly schema: "task.relate/v1";
  readonly taskId: string;
  readonly targetTaskId: string;
  readonly relation: EntityRelationRecord;
  readonly body: string;
}

export interface DecisionProposePayloadV2 {
  readonly schema: "decision.propose/v1";
  readonly decision: DecisionPackage;
  readonly body?: string;
}

export type DecisionStateTransitionV2 = "accept" | "reject" | "defer" | "supersede" | "retire";

export interface DecisionStatePayloadV2 {
  readonly schema: "decision.state/v1";
  readonly transition: DecisionStateTransitionV2;
  readonly decision: DecisionPackage;
  readonly body?: string;
}

export interface DecisionAmendPayloadV2 {
  readonly schema: "decision.amend/v1";
  readonly decision: DecisionPackage;
  readonly body?: string;
}

export interface DecisionRelationPayloadV2 {
  readonly schema: "decision.relation/v1";
  readonly decisionId: string;
  readonly relation: EntityRelationRecord;
  readonly taskWrites?: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly body: string }>;
}

export interface DecisionRelationRetirePayloadV2 {
  readonly schema: "decision.relation-retire/v1";
  readonly decisionId: string;
  readonly relationId: string;
  readonly decision: DecisionPackage;
  readonly body?: string;
}

export interface DecisionRelationReplacePayloadV2 {
  readonly schema: "decision.relation-replace/v1";
  readonly decisionId: string;
  readonly relationId: string;
  readonly replacement: EntityRelationRecord;
  readonly decision: DecisionPackage;
  readonly taskWrites?: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly body: string }>;
  readonly body?: string;
}

export interface ModuleRecordV2 {
  readonly key: string;
  readonly title: string;
  readonly prefix?: string;
  readonly status: string;
  readonly branch?: string;
  readonly owner?: string;
  readonly currentStep?: string;
  readonly scopes: ReadonlyArray<string>;
  readonly shared?: ReadonlyArray<string>;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<{ readonly id: string; readonly state: string }>;
}

export interface ModuleRegisterPayloadV2 {
  readonly schema: "module.register/v1";
  readonly module: ModuleRecordV2;
}

export interface ModuleUnregisterPayloadV2 {
  readonly schema: "module.unregister/v1";
  readonly moduleKey: string;
}

export interface ModuleStepPayloadV2 {
  readonly schema: "module.step/v1";
  readonly moduleKey: string;
  readonly stepId: string;
  readonly state: "planned" | "in-progress" | "blocked" | "done";
}

export type TaskDecisionModuleCommandPayloadV2 =
  | TaskCreatePayloadV2
  | TaskTransitionPayloadV2
  | TaskAppendPayloadV2
  | TaskDocumentPayloadV2
  | TaskAmendPayloadV2
  | TaskArchivePayloadV2
  | TaskSupersedePayloadV2
  | TaskDeletePayloadV2
  | TaskReopenPayloadV2
  | TaskRelatePayloadV2
  | DecisionProposePayloadV2
  | DecisionStatePayloadV2
  | DecisionAmendPayloadV2
  | DecisionRelationPayloadV2
  | DecisionRelationRetirePayloadV2
  | DecisionRelationReplacePayloadV2
  | ModuleRegisterPayloadV2
  | ModuleUnregisterPayloadV2
  | ModuleStepPayloadV2;

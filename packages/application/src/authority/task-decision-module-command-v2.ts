import { Schema } from "effect";
import {
  DecisionPackageSchema,
  type DecisionPackage,
  type EntityRelationRecord
} from "@harness-anything/kernel";
import { canonicalPayloadDigestV2, decodeRelationV2 } from "./fact-relation-command-v2.ts";
import {
  bytesEqual,
  type SemanticMutationEnvelopeV2
} from "./semantic-mutation-envelope-v2.ts";
import {
  semanticAdmissionV2,
  semanticStringValueV2
} from "./semantic-authority-helpers-v2.ts";
import {
  taskDecisionModuleNonBlank,
  taskDecisionModuleRegistryKey as registryKey,
  taskDecisionModuleText,
  taskDecisionModuleTextList as textList
} from "./task-decision-module-payload-values-v2.ts";

export const taskDecisionModuleTypedCommandsV2 = [
  "task.create",
  "task.transition",
  "task.append",
  "task.document",
  "task.amend",
  "task.archive",
  "task.supersede",
  "task.delete",
  "task.reopen",
  "task.relate",
  "decision.propose",
  "decision.state",
  "decision.amend",
  "decision.relation",
  "decision.relation-retire",
  "decision.relation-replace",
  "module.register",
  "module.unregister",
  "module.step"
] as const;

export type TaskDecisionModuleTypedCommandV2 = (typeof taskDecisionModuleTypedCommandsV2)[number];

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

export function decodeTaskDecisionModuleCommandPayloadV2(envelope: SemanticMutationEnvelopeV2): {
  readonly payload: TaskDecisionModuleCommandPayloadV2;
  readonly decodedBytes: bigint;
} {
  if (envelope.intent.kind !== "typed") throw semanticAdmissionV2("TYPED_COMMAND_REQUIRED");
  if (envelope.intent.command.registryVersion !== 1 || envelope.intent.command.version !== 1) {
    throw semanticAdmissionV2("TYPED_COMMAND_VERSION_UNSUPPORTED");
  }
  if (!taskDecisionModuleTypedCommandsV2.includes(envelope.intent.command.name as TaskDecisionModuleTypedCommandV2)) {
    throw semanticAdmissionV2("TYPED_COMMAND_UNREGISTERED");
  }
  if (envelope.intent.canonicalPayload.kind !== "inline") throw semanticAdmissionV2("AUTHORITY_PAYLOAD_CAS_UNSUPPORTED");
  const bytes = envelope.intent.canonicalPayload.bytes;
  if (envelope.intent.canonicalPayload.size !== BigInt(bytes.length)) throw semanticAdmissionV2("CANONICAL_PAYLOAD_SIZE_MISMATCH");
  if (!bytesEqual(envelope.intent.canonicalPayloadDigest, canonicalPayloadDigestV2(bytes))) {
    throw semanticAdmissionV2("CANONICAL_PAYLOAD_DIGEST_MISMATCH");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  }
  const payload = strictTaskDecisionModulePayload(decoded);
  if (!bytesEqual(bytes, encodeTaskDecisionModuleCommandPayloadV2(payload))) {
    throw semanticAdmissionV2("TYPED_PAYLOAD_NON_CANONICAL");
  }
  if (payload.schema.replace("/v1", "") !== envelope.intent.command.name) {
    throw semanticAdmissionV2("TYPED_COMMAND_PAYLOAD_MISMATCH");
  }
  return { payload, decodedBytes: BigInt(bytes.length) };
}

export function encodeTaskDecisionModuleCommandPayloadV2(payload: TaskDecisionModuleCommandPayloadV2): Uint8Array {
  return Buffer.from(JSON.stringify(canonicalTaskDecisionModulePayloadWire(payload)), "utf8");
}

function strictTaskDecisionModulePayload(value: unknown): TaskDecisionModuleCommandPayloadV2 {
  const discriminator = exactTaskDecisionModuleObject(value, ["schema"], true);
  switch (discriminator.schema) {
    case "task.create/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "taskId", "packageSlug", "indexBody", "writes"], false, ["packageSlug", "writes"]);
      return {
        schema: discriminator.schema,
        taskId: taskDecisionModuleText(row.taskId),
        ...(row.packageSlug === undefined ? {} : { packageSlug: taskDecisionModuleText(row.packageSlug) }),
        indexBody: semanticStringValueV2(row.indexBody),
        ...(row.writes === undefined ? {} : { writes: taskCreateWrites(row.writes) })
      };
    }
    case "task.transition/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "taskId", "to", "auditText"], false, ["auditText"]);
      return {
        schema: discriminator.schema, taskId: taskDecisionModuleText(row.taskId), to: taskDecisionModuleText(row.to),
        ...(row.auditText === undefined ? {} : { auditText: taskDecisionModuleNonBlank(row.auditText) })
      };
    }
    case "task.append/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "taskId", "text"]);
      return { schema: discriminator.schema, taskId: taskDecisionModuleText(row.taskId), text: taskDecisionModuleNonBlank(row.text) };
    }
    case "task.document/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "taskId", "path", "body"]);
      return { schema: discriminator.schema, taskId: taskDecisionModuleText(row.taskId), path: taskDecisionModuleText(row.path), body: semanticStringValueV2(row.body) };
    }
    case "task.amend/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "taskId", "fields", "body"]);
      return { schema: discriminator.schema, taskId: taskDecisionModuleText(row.taskId), fields: textList(row.fields, "TASK_AMEND_FIELDS_INVALID"), body: semanticStringValueV2(row.body) };
    }
    case "task.archive/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "taskId", "reason", "body"]);
      return { schema: discriminator.schema, taskId: taskDecisionModuleText(row.taskId), reason: taskDecisionModuleNonBlank(row.reason), body: semanticStringValueV2(row.body) };
    }
    case "task.supersede/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "taskId", "body", "replacementTaskId", "writes"], false, ["body", "replacementTaskId", "writes"]);
      return {
        schema: discriminator.schema,
        taskId: taskDecisionModuleText(row.taskId),
        ...(optionalString(row.body, "body")),
        ...(row.replacementTaskId === undefined ? {} : { replacementTaskId: taskDecisionModuleText(row.replacementTaskId) }),
        ...(row.writes === undefined ? {} : { writes: taskSupersedeWrites(row.writes) })
      };
    }
    case "task.delete/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "taskId", "mode", "reason", "body"]);
      if (row.mode !== "soft") throw semanticAdmissionV2("TASK_HARD_DELETE_UNAVAILABLE");
      return { schema: discriminator.schema, taskId: taskDecisionModuleText(row.taskId), mode: "soft", reason: taskDecisionModuleNonBlank(row.reason), body: semanticStringValueV2(row.body) };
    }
    case "task.reopen/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "taskId", "reason", "body"]);
      return { schema: discriminator.schema, taskId: taskDecisionModuleText(row.taskId), reason: taskDecisionModuleNonBlank(row.reason), body: semanticStringValueV2(row.body) };
    }
    case "task.relate/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "taskId", "targetTaskId", "relation", "body"]);
      return { schema: discriminator.schema, taskId: taskDecisionModuleText(row.taskId), targetTaskId: taskDecisionModuleText(row.targetTaskId), relation: decodeRelationV2(row.relation), body: semanticStringValueV2(row.body) };
    }
    case "decision.propose/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "decision", "body"], false, ["body"]);
      return { schema: discriminator.schema, decision: decision(row.decision), ...(optionalString(row.body, "body")) };
    }
    case "decision.state/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "transition", "decision", "body"], false, ["body"]);
      const transition = taskDecisionModuleText(row.transition);
      if (!["accept", "reject", "defer", "supersede", "retire"].includes(transition)) {
        throw semanticAdmissionV2("DECISION_STATE_TRANSITION_UNSUPPORTED");
      }
      return {
        schema: discriminator.schema,
        transition: transition as DecisionStateTransitionV2,
        decision: decision(row.decision),
        ...(optionalString(row.body, "body"))
      };
    }
    case "decision.amend/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "decision", "body"], false, ["body"]);
      return { schema: discriminator.schema, decision: decision(row.decision), ...(optionalString(row.body, "body")) };
    }
    case "decision.relation/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "decisionId", "relation", "taskWrites"], false, ["taskWrites"]);
      return {
        schema: discriminator.schema,
        decisionId: taskDecisionModuleText(row.decisionId),
        relation: decodeRelationV2(row.relation),
        ...(row.taskWrites === undefined ? {} : { taskWrites: decisionRelationTaskWrites(row.taskWrites) })
      };
    }
    case "decision.relation-retire/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "decisionId", "relationId", "decision", "body"], false, ["body"]);
      return { schema: discriminator.schema, decisionId: taskDecisionModuleText(row.decisionId), relationId: taskDecisionModuleText(row.relationId), decision: decision(row.decision), ...(optionalString(row.body, "body")) };
    }
    case "decision.relation-replace/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "decisionId", "relationId", "replacement", "decision", "taskWrites", "body"], false, ["taskWrites", "body"]);
      return {
        schema: discriminator.schema,
        decisionId: taskDecisionModuleText(row.decisionId),
        relationId: taskDecisionModuleText(row.relationId),
        replacement: decodeRelationV2(row.replacement),
        decision: decision(row.decision),
        ...(row.taskWrites === undefined ? {} : { taskWrites: decisionRelationTaskWrites(row.taskWrites) }),
        ...(optionalString(row.body, "body"))
      };
    }
    case "module.register/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "module"]);
      return { schema: discriminator.schema, module: moduleRecord(row.module) };
    }
    case "module.unregister/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "moduleKey"]);
      return { schema: discriminator.schema, moduleKey: registryKey(row.moduleKey) };
    }
    case "module.step/v1": {
      const row = exactTaskDecisionModuleObject(value, ["schema", "moduleKey", "stepId", "state"]);
      const state = taskDecisionModuleText(row.state);
      if (!["planned", "in-progress", "blocked", "done"].includes(state)) throw semanticAdmissionV2("MODULE_STEP_STATE_INVALID");
      return {
        schema: discriminator.schema,
        moduleKey: registryKey(row.moduleKey),
        stepId: taskDecisionModuleText(row.stepId),
        state: state as ModuleStepPayloadV2["state"]
      };
    }
    default:
      throw semanticAdmissionV2("TYPED_PAYLOAD_SCHEMA_UNSUPPORTED");
  }
}

function canonicalTaskDecisionModulePayloadWire(payload: TaskDecisionModuleCommandPayloadV2): object {
  switch (payload.schema) {
    case "task.create/v1":
      return {
        schema: payload.schema,
        taskId: payload.taskId,
        ...(payload.packageSlug ? { packageSlug: payload.packageSlug } : {}),
        indexBody: payload.indexBody,
        ...(payload.writes ? { writes: payload.writes.map((write) => ({ path: write.path, body: write.body, ...(write.packageSlug ? { packageSlug: write.packageSlug } : {}) })) } : {})
      };
    case "task.transition/v1":
      return { schema: payload.schema, taskId: payload.taskId, to: payload.to, ...(payload.auditText === undefined ? {} : { auditText: payload.auditText }) };
    case "task.append/v1":
      return { schema: payload.schema, taskId: payload.taskId, text: payload.text };
    case "task.document/v1":
      return { schema: payload.schema, taskId: payload.taskId, path: payload.path, body: payload.body };
    case "task.amend/v1":
      return { schema: payload.schema, taskId: payload.taskId, fields: [...payload.fields], body: payload.body };
    case "task.archive/v1":
      return { schema: payload.schema, taskId: payload.taskId, reason: payload.reason, body: payload.body };
    case "task.supersede/v1":
      return { schema: payload.schema, taskId: payload.taskId, ...(payload.body === undefined ? {} : { body: payload.body }), ...(payload.replacementTaskId === undefined ? {} : { replacementTaskId: payload.replacementTaskId }), ...(payload.writes ? { writes: payload.writes.map((write) => ({ taskId: write.taskId, path: write.path, body: write.body, ...(write.packageSlug ? { packageSlug: write.packageSlug } : {}) })) } : {}) };
    case "task.delete/v1":
      return { schema: payload.schema, taskId: payload.taskId, mode: payload.mode, reason: payload.reason, body: payload.body };
    case "task.reopen/v1":
      return { schema: payload.schema, taskId: payload.taskId, reason: payload.reason, body: payload.body };
    case "task.relate/v1":
      return { schema: payload.schema, taskId: payload.taskId, targetTaskId: payload.targetTaskId, relation: relationWire(payload.relation), body: payload.body };
    case "decision.propose/v1":
      return { schema: payload.schema, decision: decisionWire(payload.decision), ...(payload.body === undefined ? {} : { body: payload.body }) };
    case "decision.state/v1":
      return { schema: payload.schema, transition: payload.transition, decision: decisionWire(payload.decision), ...(payload.body === undefined ? {} : { body: payload.body }) };
    case "decision.amend/v1":
      return { schema: payload.schema, decision: decisionWire(payload.decision), ...(payload.body === undefined ? {} : { body: payload.body }) };
    case "decision.relation/v1":
      return {
        schema: payload.schema, decisionId: payload.decisionId, relation: relationWire(payload.relation),
        ...(payload.taskWrites ? { taskWrites: payload.taskWrites.map((write) => ({ taskId: write.taskId, path: write.path, body: write.body })) } : {})
      };
    case "decision.relation-retire/v1":
      return { schema: payload.schema, decisionId: payload.decisionId, relationId: payload.relationId, decision: decisionWire(payload.decision), ...(payload.body === undefined ? {} : { body: payload.body }) };
    case "decision.relation-replace/v1":
      return { schema: payload.schema, decisionId: payload.decisionId, relationId: payload.relationId, replacement: relationWire(payload.replacement), decision: decisionWire(payload.decision), ...(payload.taskWrites ? { taskWrites: payload.taskWrites.map((write) => ({ taskId: write.taskId, path: write.path, body: write.body })) } : {}), ...(payload.body === undefined ? {} : { body: payload.body }) };
    case "module.register/v1":
      return { schema: payload.schema, module: moduleWire(payload.module) };
    case "module.unregister/v1":
      return { schema: payload.schema, moduleKey: payload.moduleKey };
    case "module.step/v1":
      return { schema: payload.schema, moduleKey: payload.moduleKey, stepId: payload.stepId, state: payload.state };
  }
}

function decisionRelationTaskWrites(value: unknown): NonNullable<DecisionRelationPayloadV2["taskWrites"]> {
  if (!Array.isArray(value) || value.length !== 1) throw semanticAdmissionV2("DECISION_RELATION_TASK_WRITES_INVALID");
  return value.map((entry) => {
    const row = exactTaskDecisionModuleObject(entry, ["taskId", "path", "body"]);
    return {
      taskId: taskDecisionModuleText(row.taskId),
      path: taskDecisionModuleText(row.path),
      body: semanticStringValueV2(row.body)
    };
  });
}

function taskCreateWrites(value: unknown): NonNullable<TaskCreatePayloadV2["writes"]> {
  if (!Array.isArray(value) || value.length === 0) throw semanticAdmissionV2("TASK_CREATE_WRITES_INVALID");
  return value.map((entry) => {
    const row = exactTaskDecisionModuleObject(entry, ["path", "body", "packageSlug"], false, ["packageSlug"]);
    return {
      path: taskDecisionModuleText(row.path),
      body: semanticStringValueV2(row.body),
      ...(row.packageSlug === undefined ? {} : { packageSlug: taskDecisionModuleText(row.packageSlug) })
    };
  });
}

function taskSupersedeWrites(value: unknown): NonNullable<TaskSupersedePayloadV2["writes"]> {
  if (!Array.isArray(value) || value.length < 3) throw semanticAdmissionV2("TASK_SUPERSEDE_WRITES_INVALID");
  return value.map((entry) => {
    const row = exactTaskDecisionModuleObject(entry, ["taskId", "path", "body", "packageSlug"], false, ["packageSlug"]);
    return {
      taskId: taskDecisionModuleText(row.taskId),
      path: taskDecisionModuleText(row.path),
      body: semanticStringValueV2(row.body),
      ...(row.packageSlug === undefined ? {} : { packageSlug: taskDecisionModuleText(row.packageSlug) })
    };
  });
}

function decision(value: unknown): DecisionPackage {
  try {
    return Schema.decodeUnknownSync(DecisionPackageSchema)(value);
  } catch {
    throw semanticAdmissionV2("DECISION_PAYLOAD_INVALID");
  }
}

function decisionWire(value: DecisionPackage): object {
  return {
    schema: value.schema,
    decision_id: value.decision_id,
    ...(value._coordinatorWatermark === undefined ? {} : { _coordinatorWatermark: value._coordinatorWatermark }),
    title: value.title,
    state: value.state,
    riskTier: value.riskTier,
    urgency: value.urgency,
    vertical: value.vertical,
    preset: value.preset,
    ...(value.decisionClass === undefined ? {} : { decisionClass: value.decisionClass }),
    applies_to: { modules: [...value.applies_to.modules], productLines: [...value.applies_to.productLines] },
    proposedAt: value.proposedAt,
    ...(value.decidedAt === undefined ? {} : { decidedAt: value.decidedAt }),
    ...(value.contentPins === undefined ? {} : { contentPins: value.contentPins.map((entry) => ({ ...entry })) }),
    provenance: value.provenance.map((entry) => ({ ...entry })),
    question: value.question,
    chosen: value.chosen.map((entry) => ({ ...entry })),
    rejected: value.rejected.map((entry) => ({ ...entry })),
    claims: value.claims.map((entry) => ({ ...entry })),
    relations: value.relations.map(relationWire)
  };
}

function relationWire(value: EntityRelationRecord): object {
  return {
    relation_id: value.relation_id,
    source: value.source,
    target: value.target,
    type: value.type,
    strength: value.strength,
    direction: value.direction,
    origin: value.origin,
    rationale: value.rationale,
    state: value.state
  };
}

function moduleRecord(value: unknown): ModuleRecordV2 {
  const row = exactTaskDecisionModuleObject(value, [
    "key", "title", "prefix", "status", "branch", "owner", "currentStep", "scopes", "shared", "dependsOn", "steps"
  ], false, ["prefix", "branch", "owner", "currentStep", "shared", "dependsOn"]);
  const steps = taskDecisionModuleArray(row.steps, "steps").map((entry) => {
    const step = exactTaskDecisionModuleObject(entry, ["id", "state"]);
    return { id: taskDecisionModuleText(step.id), state: taskDecisionModuleText(step.state) };
  });
  return {
    key: registryKey(row.key),
    title: taskDecisionModuleNonBlank(row.title),
    ...(row.prefix === undefined ? {} : { prefix: taskDecisionModuleText(row.prefix) }),
    status: taskDecisionModuleText(row.status),
    ...(row.branch === undefined ? {} : { branch: taskDecisionModuleText(row.branch) }),
    ...(row.owner === undefined ? {} : { owner: taskDecisionModuleText(row.owner) }),
    ...(row.currentStep === undefined ? {} : { currentStep: taskDecisionModuleText(row.currentStep) }),
    scopes: stringArray(row.scopes, "scopes"),
    ...(row.shared === undefined ? {} : { shared: stringArray(row.shared, "shared") }),
    ...(row.dependsOn === undefined ? {} : { dependsOn: stringArray(row.dependsOn, "dependsOn") }),
    steps
  };
}

function moduleWire(value: ModuleRecordV2): object {
  return {
    key: value.key,
    title: value.title,
    ...(value.prefix === undefined ? {} : { prefix: value.prefix }),
    status: value.status,
    ...(value.branch === undefined ? {} : { branch: value.branch }),
    ...(value.owner === undefined ? {} : { owner: value.owner }),
    ...(value.currentStep === undefined ? {} : { currentStep: value.currentStep }),
    scopes: [...value.scopes],
    ...(value.shared === undefined ? {} : { shared: [...value.shared] }),
    ...(value.dependsOn === undefined ? {} : { dependsOn: [...value.dependsOn] }),
    steps: value.steps.map((step) => ({ id: step.id, state: step.state }))
  };
}

function exactTaskDecisionModuleObject(
  value: unknown,
  keys: ReadonlyArray<string>,
  allowAdditional = false,
  optional: ReadonlyArray<string> = []
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row);
  if (keys.some((key) => !optional.includes(key) && !actual.includes(key))
    || (!allowAdditional && actual.some((key) => !keys.includes(key)))) {
    throw semanticAdmissionV2("TYPED_PAYLOAD_UNKNOWN_OR_MISSING_FIELD");
  }
  return row;
}

function optionalString(value: unknown, key: string): Readonly<Record<string, string>> {
  return value === undefined ? {} : { [key]: semanticStringValueV2(value) };
}

function taskDecisionModuleArray(value: unknown, name: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID", name);
  return value;
}

function stringArray(value: unknown, name: string): ReadonlyArray<string> {
  return taskDecisionModuleArray(value, name).map(taskDecisionModuleText);
}

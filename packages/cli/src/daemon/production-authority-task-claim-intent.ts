import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";
import { encodeSessionExecutionReviewCommandPayloadV2 } from "@harness-anything/application";
import {
  executionDeclaration,
  taskHolderActor,
  type CurrentSessionRef,
  type ExecutionRecord,
  type WriteOp
} from "@harness-anything/kernel";
import type { ParsedCommand } from "../cli/types.ts";
import type { CliActorAttribution } from "../composition/actor-attribution.ts";
import type { CanonicalAttemptIntent } from "./production-authority-attempt-compiler.ts";

export function taskClaimAttemptIntent(
  command: ParsedCommand,
  attribution: CliActorAttribution,
  currentSession: CurrentSessionRef,
  operation: WriteOp
): CanonicalAttemptIntent {
  const action = command.action;
  if (action.kind !== "task-claim") throw new Error("AUTHORITY_TASK_CLAIM_COMMAND_REQUIRED");
  if (operation.kind !== "doc_write") throw new Error("AUTHORITY_TASK_CLAIM_OPERATION_MISMATCH");
  const payload = exactRecord(operation.payload, ["entityDocument", "companionWrites", "preconditions"], "AUTHORITY_TASK_CLAIM_PAYLOAD_INVALID");
  if (!Array.isArray(payload.companionWrites) || payload.companionWrites.length !== 0
    || !Array.isArray(payload.preconditions) || payload.preconditions.length !== 0) {
    throw new Error("AUTHORITY_TASK_CLAIM_WRITE_SET_INVALID");
  }
  const document = exactRecord(payload.entityDocument, ["declaration", "identity", "body"], "AUTHORITY_TASK_CLAIM_DOCUMENT_INVALID");
  const declaration = exactRecord(document.declaration, ["kind", "storageForm", "rootResolver"], "AUTHORITY_TASK_CLAIM_DECLARATION_INVALID");
  const expectedDeclaration = {
    kind: executionDeclaration.kind,
    storageForm: executionDeclaration.storageForm,
    rootResolver: executionDeclaration.rootResolver
  };
  if (!isDeepStrictEqual(declaration, expectedDeclaration)) throw new Error("AUTHORITY_TASK_CLAIM_DECLARATION_MISMATCH");
  const identity = exactRecord(document.identity, ["taskId", "executionId"], "AUTHORITY_TASK_CLAIM_IDENTITY_INVALID");
  if (identity.taskId !== action.taskId || typeof identity.executionId !== "string" || !identity.executionId) {
    throw new Error("AUTHORITY_TASK_CLAIM_IDENTITY_MISMATCH");
  }
  if (action.executionId !== undefined && action.executionId !== identity.executionId) {
    throw new Error("AUTHORITY_TASK_CLAIM_EXPLICIT_EXECUTION_MISMATCH");
  }
  if (typeof document.body !== "string") throw new Error("AUTHORITY_TASK_CLAIM_BODY_INVALID");
  const execution = decodeExecution(document.body);
  if (operation.entityId !== `entity/execution/${execution.execution_id}`
    || execution.execution_id !== identity.executionId
    || execution.task_ref !== `task/${action.taskId}`) {
    throw new Error("AUTHORITY_TASK_CLAIM_ENTITY_MISMATCH");
  }
  if (execution.state !== "active" || execution.submitted_at !== null || execution.closed_at !== null
    || execution.submission !== null || execution.outputs.length !== 0) {
    throw new Error("AUTHORITY_TASK_CLAIM_STATE_INVALID");
  }
  const expectedActor = taskHolderActor(attribution.taskHolderPrincipal, attribution.executor);
  if (!isDeepStrictEqual(execution.primary_actor, expectedActor)) throw new Error("AUTHORITY_TASK_CLAIM_ACTOR_MISMATCH");
  assertSessionBinding(execution, currentSession);
  const executionId = execution.execution_id;
  const entity = {
    registryVersion: 1 as const,
    entityKind: "execution",
    canonicalRef: `execution/${action.taskId}/${executionId}`
  };
  const typedPayload = { schema: "execution.claim/v1" as const, taskId: action.taskId, execution };
  return {
    commandName: "execution.claim",
    payload: encodeSessionExecutionReviewCommandPayloadV2(typedPayload),
    mutations: [{ entity, action: "claim" }],
    baseRefs: [entity],
    portablePaths: [`tasks/${action.taskId}/executions/${executionId}.md`],
    declaredPathCas: [],
    physicalEntityId: operation.entityId
  };
}

function decodeExecution(body: string): ExecutionRecord {
  let execution: ExecutionRecord;
  try {
    execution = Schema.decodeUnknownSync(executionDeclaration.schema)(
      executionDeclaration.documentCodec.decode(body)
    ) as ExecutionRecord;
  } catch {
    throw new Error("AUTHORITY_TASK_CLAIM_BODY_INVALID");
  }
  if (executionDeclaration.documentCodec.encode(execution) !== body) {
    throw new Error("AUTHORITY_TASK_CLAIM_BODY_NON_CANONICAL");
  }
  return execution;
}

function assertSessionBinding(execution: ExecutionRecord, currentSession: CurrentSessionRef): void {
  if (execution.session_bindings.length !== 1) throw new Error("AUTHORITY_TASK_CLAIM_SESSION_BINDING_INVALID");
  const binding = execution.session_bindings[0]!;
  const expectedSession = currentSession.runtime === "human" ? null : currentSession;
  const expectedSessionRef = expectedSession ? `session/${currentSession.sessionId}` : null;
  const expectedBindingId = expectedSession ? `primary:${currentSession.sessionId}` : "primary:pending";
  if (binding.role !== "primary" || binding.archive_status !== "pending"
    || binding.binding_id !== expectedBindingId || binding.session_ref !== expectedSessionRef
    || !isDeepStrictEqual(binding.session, expectedSession)) {
    throw new Error("AUTHORITY_TASK_CLAIM_SESSION_BINDING_MISMATCH");
  }
  const range = binding.capture_range;
  if (!range || range.coordinate !== "timestamp" || range.start_at !== binding.attached_at
    || range.end_at !== null || range.bounds !== "inclusive"
    || range.range_id !== `primary:${expectedSession?.sessionId ?? "pending"}:${binding.attached_at}`) {
    throw new Error("AUTHORITY_TASK_CLAIM_CAPTURE_RANGE_INVALID");
  }
}

function exactRecord(value: unknown, keys: ReadonlyArray<string>, error: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) {
    throw new Error(error);
  }
  return value as Record<string, unknown>;
}

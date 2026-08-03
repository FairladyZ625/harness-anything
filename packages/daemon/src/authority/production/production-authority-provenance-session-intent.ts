import { readFileSync } from "node:fs";
import path from "node:path";
import {
  encodeSessionExecutionReviewCommandPayloadV2,
  type ProductionAuthorityCommand,
  type SessionExecutionReviewCommandPayloadV2
} from "@harness-anything/application";
import {
  executionDeclaration,
  readContentAddressedTextBlob,
  taskPackagePath,
  type CurrentSessionRef,
  type ExecutionRecord,
  type RegistryEntityRefV2,
  type SessionManifest,
  type WriteOp
} from "@harness-anything/kernel";
import type { CanonicalAttemptIntent } from "./production-authority-attempt-compiler.ts";

export function provenanceSessionAttemptIntent(
  command: ProductionAuthorityCommand,
  currentSession: CurrentSessionRef,
  operation: WriteOp
): CanonicalAttemptIntent {
  const sessionAction = command.action.kind === "session-export" ? command.action : undefined;
  const executionSession = command.action.kind === "task-submit"
    ? boundExecutionPrimarySession(command)
    : undefined;
  const expectedSessionId = sessionAction?.sessionId ?? executionSession?.sessionId ?? currentSession.sessionId;
  const expectedEntityId = `entity/session/${expectedSessionId}`;
  const supportsProvenanceExport = command.action.kind === "new-task"
    || command.action.kind === "session-export"
    || command.action.kind === "task-submit";
  if (!supportsProvenanceExport || operation.entityId !== expectedEntityId || operation.kind !== "doc_write") {
    throw new Error("AUTHORITY_CREATE_PROVENANCE_OPERATION_INVALID");
  }
  const payload = plainRecord(operation.payload);
  const document = plainRecord(payload?.entityDocument);
  const declaration = plainRecord(document?.declaration);
  const rootResolver = plainRecord(declaration?.rootResolver);
  const identity = plainRecord(document?.identity);
  const blobRef = plainRecord(document?.blobRef);
  if (!payload || !document || !declaration || !rootResolver || !identity || !blobRef
    || Object.keys(payload).some((key) => key !== "entityDocument")
    || Object.keys(document).some((key) => !["declaration", "identity", "body", "blobRef"].includes(key))
    || declaration.kind !== "session"
    || declaration.storageForm !== "composite-manifest-blob"
    || rootResolver.pathTemplate !== "sessions/{sessionId}.md"
    || !Array.isArray(rootResolver.identity)
    || rootResolver.identity.length !== 1
    || rootResolver.identity[0] !== "sessionId"
    || Object.keys(identity).length !== 1
    || identity.sessionId !== expectedSessionId
    || typeof document.body !== "string") {
    throw new Error("AUTHORITY_CREATE_PROVENANCE_OPERATION_INVALID");
  }
  let decodedManifest: unknown;
  try {
    decodedManifest = JSON.parse(document.body);
  } catch {
    throw new Error("AUTHORITY_CREATE_PROVENANCE_MANIFEST_INVALID");
  }
  const manifestRecord = plainRecord(decodedManifest);
  const manifestBodyRef = plainRecord(manifestRecord?.bodyRef);
  const expectedRuntime = sessionAction?.runtime ?? executionSession?.runtime ?? currentSession.runtime;
  const expectedSource = sessionAction
    ? sessionAction.sessionId ? sessionAction.source ?? "manual" : currentSession.source
    : executionSession?.source ?? currentSession.source;
  const expectedUser = sessionAction
    ? sessionAction.sessionId ? sessionAction.user : currentSession.user
    : executionSession ? executionSession.user : currentSession.user;
  const expectedDetectedAt = sessionAction
    ? sessionAction.sessionId ? sessionAction.detectedAt : currentSession.detectedAt
    : executionSession?.detectedAt ?? (command.action.kind === "new-task" ? currentSession.detectedAt : undefined);
  const manifestMismatches = [
    !manifestRecord && "manifest",
    !manifestBodyRef && "bodyRef",
    manifestRecord?.schema !== "session-entity/v1" && "schema",
    manifestRecord?.sessionId !== expectedSessionId && "sessionId",
    manifestRecord?.runtime !== expectedRuntime && "runtime",
    manifestRecord?.source !== expectedSource && "source",
    ((expectedDetectedAt !== undefined
      ? manifestRecord?.detectedAt !== expectedDetectedAt
      : typeof manifestRecord?.detectedAt !== "string" || Number.isNaN(Date.parse(manifestRecord.detectedAt)))) && "detectedAt",
    (manifestRecord?.user ?? undefined) !== (expectedUser ?? undefined) && "user",
    manifestBodyRef?.store !== "authored-cas/v1" && "bodyRef.store",
    manifestBodyRef?.ref !== blobRef.ref && "bodyRef.ref",
    manifestBodyRef?.sha256 !== blobRef.sha256 && "bodyRef.sha256",
    manifestBodyRef?.size !== blobRef.size && "bodyRef.size",
    manifestBodyRef?.mediaType !== blobRef.mediaType && "bodyRef.mediaType"
  ].filter((value): value is string => typeof value === "string");
  if (manifestMismatches.length > 0) {
    throw new Error(`AUTHORITY_CREATE_PROVENANCE_MANIFEST_INVALID:${manifestMismatches.join(",")}`);
  }
  const manifest = decodedManifest as SessionManifest;
  const descriptor = {
    ref: requiredString(blobRef.ref),
    sha256: requiredString(blobRef.sha256),
    size: requiredSafeSize(blobRef.size),
    mediaType: requiredString(blobRef.mediaType)
  };
  const body = readContentAddressedTextBlob({
    rootDir: command.rootDir,
    ...(command.layoutOverrides ? { layoutOverrides: command.layoutOverrides } : {})
  }, descriptor);
  const entity = sessionRef(expectedSessionId);
  const semanticPayload: SessionExecutionReviewCommandPayloadV2 = {
    schema: "session.export/v1",
    manifest,
    body
  };
  return {
    commandName: "session.export",
    payload: encodeSessionExecutionReviewCommandPayloadV2(semanticPayload),
    mutations: [{ entity, action: "export" }],
    baseRefs: [entity],
    portablePaths: [
      `sessions/${expectedSessionId}.md`,
      `objects/sha256/${descriptor.sha256.slice(0, 2)}/${descriptor.sha256.slice(2)}`
    ],
    declaredPathCas: [],
    physicalEntityId: expectedEntityId
  };
}

function boundExecutionPrimarySession(
  command: ProductionAuthorityCommand
): CurrentSessionRef {
  if (command.action.kind !== "task-submit") {
    throw new Error("AUTHORITY_SUBMIT_PROVENANCE_EXECUTION_REQUIRED");
  }
  const action = command.action;
  const executionId = action.executionId;
  if (!executionId) {
    throw new Error("AUTHORITY_SUBMIT_PROVENANCE_EXECUTION_REQUIRED");
  }
  const executionPath = path.join(taskPackagePath({
    rootDir: command.rootDir,
    ...(command.layoutOverrides ? { layoutOverrides: command.layoutOverrides } : {})
  }, action.taskId), "executions", `${executionId}.md`);
  const current = executionDeclaration.documentCodec.decode(readFileSync(executionPath, "utf8")) as ExecutionRecord;
  if (current.execution_id !== executionId || current.task_ref !== `task/${action.taskId}`) {
    throw new Error("AUTHORITY_SUBMIT_PROVENANCE_EXECUTION_IDENTITY_MISMATCH");
  }
  const primary = current.session_bindings.filter((binding) => binding.role === "primary");
  const binding = primary.length === 1 ? primary[0] : undefined;
  if (!isCurrentSessionRef(binding?.session)
      || binding.session_ref !== `session/${binding.session.sessionId}`) {
    throw new Error("AUTHORITY_SUBMIT_PROVENANCE_PRIMARY_SESSION_REQUIRED");
  }
  return binding.session;
}

function isCurrentSessionRef(value: unknown): value is CurrentSessionRef {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<Record<keyof CurrentSessionRef, unknown>>;
  return (session.runtime === "human"
      || session.runtime === "claude-code"
      || session.runtime === "codex"
      || session.runtime === "zcode"
      || session.runtime === "antigravity")
    && (session.source === "runtime" || session.source === "manual")
    && typeof session.sessionId === "string"
    && session.sessionId.length > 0
    && typeof session.detectedAt === "string"
    && (session.user === undefined || typeof session.user === "string");
}

function sessionRef(sessionId: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind: "session", canonicalRef: `session/${sessionId}` };
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("AUTHORITY_CREATE_PROVENANCE_BLOB_REF_INVALID");
  return value;
}

function requiredSafeSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("AUTHORITY_CREATE_PROVENANCE_BLOB_REF_INVALID");
  }
  return value;
}

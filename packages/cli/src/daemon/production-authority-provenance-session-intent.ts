import {
  encodeSessionExecutionReviewCommandPayloadV2,
  type SessionExecutionReviewCommandPayloadV2
} from "../../../application/src/index.ts";
import {
  readContentAddressedTextBlob,
  type CurrentSessionRef,
  type RegistryEntityRefV2,
  type SessionManifest,
  type WriteOp
} from "../../../kernel/src/index.ts";
import type { ParsedCommand } from "../cli/types.ts";
import type { CanonicalAttemptIntent } from "./production-authority-attempt-compiler.ts";

export function provenanceSessionAttemptIntent(
  command: ParsedCommand,
  currentSession: CurrentSessionRef,
  operation: WriteOp
): CanonicalAttemptIntent {
  const expectedEntityId = `entity/session/${currentSession.sessionId}`;
  if (command.action.kind !== "new-task" || operation.entityId !== expectedEntityId || operation.kind !== "doc_write") {
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
    || identity.sessionId !== currentSession.sessionId
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
  if (!manifestRecord || !manifestBodyRef
    || manifestRecord.schema !== "session-entity/v1"
    || manifestRecord.sessionId !== currentSession.sessionId
    || manifestRecord.runtime !== currentSession.runtime
    || manifestRecord.source !== currentSession.source
    || manifestRecord.detectedAt !== currentSession.detectedAt
    || (manifestRecord.user ?? undefined) !== (currentSession.user ?? undefined)
    || manifestBodyRef.store !== "authored-cas/v1"
    || manifestBodyRef.ref !== blobRef.ref
    || manifestBodyRef.sha256 !== blobRef.sha256
    || manifestBodyRef.size !== blobRef.size
    || manifestBodyRef.mediaType !== blobRef.mediaType) {
    throw new Error("AUTHORITY_CREATE_PROVENANCE_MANIFEST_INVALID");
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
  const entity = sessionRef(currentSession.sessionId);
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
      `sessions/${currentSession.sessionId}.md`,
      `objects/sha256/${descriptor.sha256.slice(0, 2)}/${descriptor.sha256.slice(2)}`
    ],
    declaredPathCas: [],
    physicalEntityId: expectedEntityId
  };
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

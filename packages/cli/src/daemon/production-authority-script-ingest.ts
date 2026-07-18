import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  normalizeRelativeDocumentPath,
  sha256Text,
  type CanonicalCborValue,
  type RegistryMutationPlanInput,
  type WriteOp
} from "../../../kernel/src/index.ts";
import {
  canonicalPayloadDigestV2,
  SemanticAdmissionErrorV2,
  type AuthoritySemanticCompilerV2,
  type SemanticMutationEnvelopeV2
} from "../../../application/src/index.ts";
import type { ParsedCommand } from "../cli/types.ts";
import type { CanonicalAttemptIntent } from "./production-authority-attempt-compiler.ts";

const commandName = "script.scope-ingest";
const payloadSchema = "script-scope-ingest/v1";

interface ScriptScopeWrite {
  readonly path: string;
  readonly body: string;
  readonly baseBlobSha256: string | null;
}

interface ScriptScopePayload {
  readonly schema: typeof payloadSchema;
  readonly entityId: string;
  readonly taskId: string;
  readonly writes: ReadonlyArray<ScriptScopeWrite>;
}

export function productionScriptIngestAttemptIntent(
  command: ParsedCommand,
  operation: WriteOp,
  authoredRoot: string
): CanonicalAttemptIntent {
  const taskId = scriptTaskId(command);
  if (operation.kind !== "script_ingest") throw new Error("AUTHORITY_SCRIPT_SCOPE_OPERATION_REQUIRED");
  const writes = scriptScopeWrites(operation.payload, taskId, authoredRoot);
  assertScriptRunEntityId(operation.entityId);
  const payload: ScriptScopePayload = {
    schema: payloadSchema,
    entityId: operation.entityId,
    taskId,
    writes
  };
  return {
    commandName,
    payload: encodeScriptScopePayload(payload),
    mutations: [{
      entity: { registryVersion: 1, entityKind: "task", canonicalRef: `task/${taskId}` },
      action: "document"
    }],
    baseRefs: [{ registryVersion: 1, entityKind: "task", canonicalRef: `task/${taskId}` }],
    portablePaths: writes.map((write) => write.path),
    declaredPathCas: [],
    physicalEntityId: operation.entityId
  };
}

export function makeProductionScriptIngestSemanticCompiler(authoredRoot: string): AuthoritySemanticCompilerV2 {
  return {
    compile: async (envelope) => {
      const payload = decodeScriptScopeEnvelope(envelope);
      const writes = scriptScopeWrites({ writes: payload.writes }, payload.taskId, authoredRoot);
      assertScriptRunEntityId(payload.entityId);
      return {
        mutationPlan: scriptScopeMutationPlan(payload.taskId, writes),
        operation: {
          opId: "authority-overrides-this",
          entityId: payload.entityId as WriteOp["entityId"],
          kind: "script_ingest",
          payload: { writes }
        },
        decodedBytes: BigInt(writes.reduce((total, write) => total + Buffer.byteLength(write.body), 0))
      };
    }
  };
}

export function executorDerivedFromPresetScript(command: ParsedCommand, executorAgentId: string): boolean {
  const action = command.action;
  if (action.kind === "preset-entrypoint") return executorAgentId === `preset:${action.presetId}`;
  if (action.kind !== "script-run") return false;
  const match = /^preset:([^:]+):/u.exec(action.scriptId);
  return Boolean(match?.[1]) && executorAgentId === `preset:${match![1]}`;
}

function scriptTaskId(command: ParsedCommand): string {
  const action = command.action;
  if (action.kind !== "preset-entrypoint" && action.kind !== "script-run") {
    throw new Error("AUTHORITY_SCRIPT_SCOPE_COMMAND_REQUIRED");
  }
  const taskId = action.taskId?.trim();
  if (!taskId) throw new Error("AUTHORITY_SCRIPT_SCOPE_TASK_REQUIRED");
  return taskId;
}

function scriptScopeWrites(payload: unknown, taskId: string, authoredRoot: string): ReadonlyArray<ScriptScopeWrite> {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { readonly writes?: unknown }).writes)) {
    throw new Error("AUTHORITY_SCRIPT_SCOPE_PAYLOAD_INVALID");
  }
  const writes = (payload as { readonly writes: ReadonlyArray<unknown> }).writes.map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new Error("AUTHORITY_SCRIPT_SCOPE_WRITE_INVALID");
    const row = candidate as Partial<ScriptScopeWrite>;
    if (typeof row.path !== "string" || typeof row.body !== "string"
      || (row.baseBlobSha256 !== null && typeof row.baseBlobSha256 !== "string")) {
      throw new Error("AUTHORITY_SCRIPT_SCOPE_WRITE_INVALID");
    }
    const normalized = normalizeRelativeDocumentPath(row.path);
    const expectedPrefix = `tasks/${taskId}/artifacts/`;
    if (!normalized.startsWith(expectedPrefix) || normalized.length === expectedPrefix.length) {
      throw new Error(`AUTHORITY_SCRIPT_SCOPE_PATH_DENIED:${normalized}`);
    }
    const absolute = path.join(authoredRoot, normalized);
    const currentHash = existsSync(absolute) ? sha256Text(readFileSync(absolute, "utf8")) : null;
    if (currentHash !== row.baseBlobSha256) {
      throw new Error(`AUTHORITY_SCRIPT_SCOPE_BASE_CAS_CONFLICT:${normalized}`);
    }
    return { path: normalized, body: row.body, baseBlobSha256: row.baseBlobSha256 };
  });
  if (writes.length === 0) throw new Error("AUTHORITY_SCRIPT_SCOPE_WRITES_REQUIRED");
  if (new Set(writes.map((write) => write.path)).size !== writes.length) {
    throw new Error("AUTHORITY_SCRIPT_SCOPE_DUPLICATE_PATH");
  }
  return writes;
}

function scriptScopeMutationPlan(taskId: string, writes: ReadonlyArray<ScriptScopeWrite>): RegistryMutationPlanInput {
  const contexts = writes.map((write) => ({
    packagePath: `tasks/${taskId}`,
    documentPath: write.path.slice(`tasks/${taskId}/`.length)
  }));
  return {
    registryVersion: 1,
    mutations: [{
      entityKind: "task",
      identity: { taskId },
      action: "document",
      storageContext: contexts[0],
      ...(contexts.length > 1 ? { additionalStorageContexts: contexts.slice(1) } : {})
    }]
  };
}

function assertScriptRunEntityId(entityId: string): void {
  if (!/^entity\/script-run\/[a-f0-9]{32}$/u.test(entityId)) {
    throw new Error("AUTHORITY_SCRIPT_SCOPE_ENTITY_INVALID");
  }
}

function encodeScriptScopePayload(payload: ScriptScopePayload): Uint8Array {
  return encodeCanonicalCbor({
    schema: payload.schema,
    entityId: payload.entityId,
    taskId: payload.taskId,
    writes: payload.writes.map((write) => ({ ...write }))
  });
}

function decodeScriptScopeEnvelope(envelope: SemanticMutationEnvelopeV2): ScriptScopePayload {
  if (envelope.intent.kind !== "typed" || envelope.intent.command.name !== commandName
    || envelope.intent.canonicalPayload.kind !== "inline") {
    throw new SemanticAdmissionErrorV2("SCRIPT_SCOPE_TYPED_COMMAND_REQUIRED");
  }
  const bytes = envelope.intent.canonicalPayload.bytes;
  if (envelope.intent.canonicalPayload.size !== BigInt(bytes.byteLength)) {
    throw new SemanticAdmissionErrorV2("REQUEST_SIZE_MISMATCH");
  }
  if (!Buffer.from(canonicalPayloadDigestV2(bytes)).equals(Buffer.from(envelope.intent.canonicalPayloadDigest))) {
    throw new SemanticAdmissionErrorV2("REQUEST_DIGEST_MISMATCH");
  }
  const payload = decodeScriptScopePayload(decodeCanonicalCbor(bytes));
  if (!Buffer.from(encodeScriptScopePayload(payload)).equals(Buffer.from(bytes))) {
    throw new SemanticAdmissionErrorV2("TYPED_PAYLOAD_NON_CANONICAL");
  }
  return payload;
}

function decodeScriptScopePayload(value: CanonicalCborValue): ScriptScopePayload {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
    throw new SemanticAdmissionErrorV2("SCRIPT_SCOPE_PAYLOAD_INVALID");
  }
  const row = value as Record<string, CanonicalCborValue>;
  if (Object.keys(row).sort().join(",") !== "entityId,schema,taskId,writes"
    || row.schema !== payloadSchema || typeof row.entityId !== "string" || typeof row.taskId !== "string"
    || !Array.isArray(row.writes)) {
    throw new SemanticAdmissionErrorV2("SCRIPT_SCOPE_PAYLOAD_INVALID");
  }
  const writes = row.writes.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || candidate instanceof Uint8Array) {
      throw new SemanticAdmissionErrorV2("SCRIPT_SCOPE_WRITE_INVALID");
    }
    const write = candidate as Record<string, CanonicalCborValue>;
    if (Object.keys(write).sort().join(",") !== "baseBlobSha256,body,path"
      || typeof write.path !== "string" || typeof write.body !== "string"
      || (write.baseBlobSha256 !== null && typeof write.baseBlobSha256 !== "string")) {
      throw new SemanticAdmissionErrorV2("SCRIPT_SCOPE_WRITE_INVALID");
    }
    return { path: write.path, body: write.body, baseBlobSha256: write.baseBlobSha256 };
  });
  return { schema: payloadSchema, entityId: row.entityId, taskId: row.taskId, writes };
}

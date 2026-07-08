import { randomBytes } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  FactRecordSchema,
  deriveRelationId,
  evaluateEntityDisposition,
  isFactId,
  taskEntityId,
  type EntityRelationRecord,
  type FactConfidence,
  type FactMemoryClass,
  type FactMemoryTag,
  type FactRecord,
  type ProvenancePayload,
  type TaskId,
  type WriteCoordinator,
  type WriteError
} from "../../kernel/src/index.ts";
import { harnessRuntimeRoot, resolveHarnessLayout, type HarnessLayoutInput } from "../../kernel/src/index.ts";
import { stablePayloadHash, writeCoordinatedPayload, type PayloadHasher } from "../../kernel/src/write-coordination/write-helpers.ts";
import { bindCreateProvenance, type ProvenanceBindingOptions } from "./provenance-binding.ts";

export interface FactWriteServiceOptions extends ProvenanceBindingOptions {
  readonly rootInput: HarnessLayoutInput;
  readonly coordinator: WriteCoordinator;
  readonly hashPayload?: PayloadHasher;
  readonly now?: () => string;
  readonly generateFactId?: () => string;
}

export interface FactRecordRequest {
  readonly ownerTaskId: TaskId;
  readonly factId?: string;
  readonly statement: string;
  readonly source: string;
  readonly observedAt?: string;
  readonly confidence: FactConfidence;
  readonly memoryClass?: FactMemoryClass;
  readonly memoryTags?: ReadonlyArray<FactMemoryTag>;
  readonly dryRun?: boolean;
  readonly opIdPrefix?: string;
}

export interface FactWriteResult {
  readonly taskId: TaskId;
  readonly factId: string;
  readonly ref: string;
  readonly path: string;
}

export interface FactInvalidateRequest {
  readonly ownerTaskId: TaskId;
  readonly factId: string;
  readonly invalidatedByFactId: string;
  readonly rationale: string;
  readonly dryRun?: boolean;
  readonly opIdPrefix?: string;
}

export interface FactInvalidateResult {
  readonly taskId: TaskId;
  readonly factId: string;
  readonly invalidatedByFactId: string;
  readonly relationId: string;
  readonly ref: string;
  readonly path: string;
}

export interface FactWriteRejected {
  readonly _tag: "FactWriteRejected";
  readonly taskId: TaskId;
  readonly reason: string;
}

export interface FactWriteService {
  readonly record: (request: FactRecordRequest) => Effect.Effect<FactWriteResult, FactWriteRejected | WriteError>;
  readonly invalidate: (request: FactInvalidateRequest) => Effect.Effect<FactInvalidateResult, FactWriteRejected | WriteError>;
}

export function makeFactWriteService(options: FactWriteServiceOptions): FactWriteService {
  const hashPayload = options.hashPayload ?? stablePayloadHash;
  const timestamp = () => options.now?.() ?? new Date().toISOString();
  const generateFactId = options.generateFactId ?? randomFactId;
  return {
    record: (request) => Effect.gen(function* () {
      const layout = resolveHarnessLayout(options.rootInput);
      const factId = request.factId ?? generateFactId();
      if (!isFactId(factId)) {
        return yield* Effect.fail(factRejection(request.ownerTaskId, `invalid fact id: ${factId}`));
      }
      const observedAt = request.observedAt ?? timestamp();
      const provenance = yield* bindCreateProvenance(options, observedAt).pipe(
        Effect.catchAll((error) => Effect.fail(factRejection(request.ownerTaskId, error.reason)))
      );
      const record: FactRecord = {
        fact_id: factId,
        statement: request.statement.trim(),
        source: request.source.trim(),
        observedAt,
        confidence: request.confidence,
        memoryClass: request.memoryClass ?? "episodic",
        memoryTags: request.memoryTags ?? [],
        provenance: provenance ? [provenance] : existingFactProvenance()
      };
      const validation = validateFactRecord(request.ownerTaskId, record);
      if (validation) return yield* Effect.fail(validation);
      if (!request.dryRun) {
        yield* writeCoordinatedPayload(options.coordinator, hashPayload, {
          entityId: taskEntityId(request.ownerTaskId),
          kind: "doc_write",
          payload: {
            path: layout.factDocumentName,
            appendRecord: {
              kind: "fact-record/v1",
              record
            }
          },
          ...(request.opIdPrefix ? { opIdPrefix: request.opIdPrefix } : {})
        });
      }
      return {
        taskId: request.ownerTaskId,
        factId,
        ref: `fact/${request.ownerTaskId}/${factId}`,
        path: layout.factDocumentName
      };
    }),
    invalidate: (request) => Effect.gen(function* () {
      const layout = resolveHarnessLayout(options.rootInput);
      if (!isFactId(request.factId)) {
        return yield* Effect.fail(factRejection(request.ownerTaskId, `invalid fact id: ${request.factId}`));
      }
      if (!isFactId(request.invalidatedByFactId)) {
        return yield* Effect.fail(factRejection(request.ownerTaskId, `invalid invalidating fact id: ${request.invalidatedByFactId}`));
      }
      if (request.factId === request.invalidatedByFactId) {
        return yield* Effect.fail(factRejection(request.ownerTaskId, "fact cannot invalidate itself"));
      }
      if (request.rationale.trim().length === 0) {
        return yield* Effect.fail(factRejection(request.ownerTaskId, "fact invalidation requires a non-empty rationale"));
      }
      const disposition = evaluateEntityDisposition({
        rootDir: harnessRuntimeRoot(options.rootInput),
        layoutOverrides: typeof options.rootInput === "string" ? undefined : options.rootInput.layoutOverrides,
        entityRef: `fact/${request.ownerTaskId}/${request.factId}`,
        action: "invalidate"
      });
      if (!disposition.allowed) {
        return yield* Effect.fail(factRejection(request.ownerTaskId, disposition.reason));
      }
      const relation = invalidationRelation(request);
      if (!request.dryRun) {
        yield* writeCoordinatedPayload(options.coordinator, hashPayload, {
          entityId: taskEntityId(request.ownerTaskId),
          kind: "fact_invalidate",
          payload: {
            path: layout.factDocumentName,
            appendRecord: {
              kind: "fact-relation/v1",
              relation,
              requiresFacts: [request.factId, request.invalidatedByFactId]
            }
          },
          ...(request.opIdPrefix ? { opIdPrefix: request.opIdPrefix } : {})
        });
      }
      return {
        taskId: request.ownerTaskId,
        factId: request.factId,
        invalidatedByFactId: request.invalidatedByFactId,
        relationId: relation.relation_id,
        ref: `fact/${request.ownerTaskId}/${request.factId}`,
        path: layout.factDocumentName
      };
    })
  };
}

function existingFactProvenance(): ReadonlyArray<ProvenancePayload> {
  return [];
}

function invalidationRelation(request: FactInvalidateRequest): EntityRelationRecord {
  const base = {
    source: `fact/${request.ownerTaskId}/${request.invalidatedByFactId}`,
    target: `fact/${request.ownerTaskId}/${request.factId}`,
    type: "supersedes-fact",
    direction: "directed"
  } satisfies Pick<EntityRelationRecord, "source" | "target" | "type" | "direction">;
  return {
    relation_id: deriveRelationId(base),
    ...base,
    strength: "strong",
    origin: "declared",
    rationale: request.rationale.trim(),
    state: "active"
  };
}

function validateFactRecord(taskId: TaskId, record: FactRecord): FactWriteRejected | null {
  try {
    Schema.decodeUnknownSync(FactRecordSchema)({
      schema: "fact-record/v1",
      ...record
    });
    return null;
  } catch (error) {
    return factRejection(taskId, error instanceof Error ? error.message : "fact record schema validation failed");
  }
}

function randomFactId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(8);
  let suffix = "";
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `F-${suffix}`;
}

function factRejection(taskId: TaskId, reason: string): FactWriteRejected {
  return { _tag: "FactWriteRejected", taskId, reason };
}

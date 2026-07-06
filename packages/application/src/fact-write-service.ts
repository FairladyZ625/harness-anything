import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import {
  FactRecordSchema,
  deriveRelationId,
  evaluateEntityDisposition,
  formatFactFlowRecord,
  formatRelationFlowRecord,
  isFactId,
  parseFactFlowRecords,
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
      const factsPath = layout.taskFactDocumentPath(request.ownerTaskId);
      const existingBody = existsSync(factsPath) ? readFileSync(factsPath, "utf8") : "";
      const existingFacts = parseFactFlowRecords(existingBody);
      const factId = request.factId ?? generateFactId();
      if (!isFactId(factId)) {
        return yield* Effect.fail(factRejection(request.ownerTaskId, `invalid fact id: ${factId}`));
      }
      if (existingFacts.some((record) => record.fact_id === factId)) {
        return yield* Effect.fail(factRejection(request.ownerTaskId, `duplicate fact id: ${factId}`));
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
      const nextBody = appendFactRecord(existingBody, record);
      if (!request.dryRun) {
        yield* writeCoordinatedPayload(options.coordinator, hashPayload, {
          entityId: taskEntityId(request.ownerTaskId),
          kind: "doc_write",
          payload: {
            path: layout.factDocumentName,
            body: nextBody
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
      const factsPath = layout.taskFactDocumentPath(request.ownerTaskId);
      const existingBody = existsSync(factsPath) ? readFileSync(factsPath, "utf8") : "";
      const existingFacts = parseFactFlowRecords(existingBody);
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
      if (!existingFacts.some((record) => record.fact_id === request.factId)) {
        return yield* Effect.fail(factRejection(request.ownerTaskId, `fact not found: ${request.factId}`));
      }
      if (!existingFacts.some((record) => record.fact_id === request.invalidatedByFactId)) {
        return yield* Effect.fail(factRejection(request.ownerTaskId, `invalidating fact not found: ${request.invalidatedByFactId}`));
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
      const nextBody = appendFactRelation(existingBody, relation);
      if (!request.dryRun) {
        yield* writeCoordinatedPayload(options.coordinator, hashPayload, {
          entityId: taskEntityId(request.ownerTaskId),
          kind: "fact_invalidate",
          payload: {
            path: layout.factDocumentName,
            body: nextBody
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

function appendFactRecord(existingBody: string, record: FactRecord): string {
  const header = "# Facts\n\n";
  const base = existingBody.trim().length === 0 ? header : ensureTrailingNewline(existingBody);
  return `${base}${formatFactFlowRecord(record)}\n`;
}

function appendFactRelation(existingBody: string, relation: EntityRelationRecord): string {
  const relationLine = formatRelationFlowRecord(relation);
  if (existingBody.includes(`relation_id: ${relation.relation_id}`)) return existingBody;
  const base = existingBody.trim().length === 0 ? "# Facts\n\n" : ensureTrailingNewline(existingBody);
  if (/^relations:\s*$/mu.test(base)) return `${base}${relationLine}\n`;
  return `${base}\nrelations:\n${relationLine}\n`;
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

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
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

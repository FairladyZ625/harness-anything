import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import {
  FactRecordSchema,
  formatFactFlowRecord,
  isFactId,
  parseFactFlowRecords,
  taskEntityId,
  type CurrentSessionProbePort,
  type FactConfidence,
  type FactMemoryClass,
  type FactMemoryTag,
  type FactRecord,
  type ProvenancePayload,
  type TaskId,
  type WriteCoordinator,
  type WriteError
} from "../../kernel/src/index.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../kernel/src/layout/index.ts";
import { stablePayloadHash, writeCoordinatedPayload, type PayloadHasher } from "../../kernel/src/write-coordination/write-helpers.ts";
import { bindCreateProvenance } from "./provenance-binding.ts";
import type { ProvenanceSessionExporter } from "./provenance-session-exporter.ts";

export interface FactWriteServiceOptions {
  readonly rootInput: HarnessLayoutInput;
  readonly coordinator: WriteCoordinator;
  readonly currentSessionProbe?: CurrentSessionProbePort;
  readonly provenanceSessionExporter?: ProvenanceSessionExporter;
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

export interface FactWriteRejected {
  readonly _tag: "FactWriteRejected";
  readonly taskId: TaskId;
  readonly reason: string;
}

export interface FactWriteService {
  readonly record: (request: FactRecordRequest) => Effect.Effect<FactWriteResult, FactWriteRejected | WriteError>;
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

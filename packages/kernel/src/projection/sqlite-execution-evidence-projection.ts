import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import type { OutputEvidence } from "../domain/execution.ts";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import type { DeclaredProjectionRow } from "./entity-declaration-projection.ts";
import type { DeclaredProjectionDelta } from "./sqlite-declared-source-manifest.ts";

export function replaceExecutionEvidenceProjectionRows(
  sql: SqlClient.SqlClient,
  executionRows: ReadonlyArray<DeclaredProjectionRow>
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* createExecutionEvidenceProjectionTables(sql);
    yield* createExecutionEvidenceIndexes(sql);
    yield* sql`DELETE FROM execution_evidence_projection`;
    yield* sql`DELETE FROM execution_output_projection`;
    const summaries = executionRows.map(executionSummary);
    for (const rows of chunks(summaries, 250)) yield* insertExecutionSummaryRows(sql, rows);
    const outputs = executionRows.flatMap(executionOutputs);
    for (const rows of chunks(outputs, 250)) yield* insertExecutionOutputRows(sql, rows);
  });
}

export function applyExecutionEvidenceProjectionDelta(
  sql: SqlClient.SqlClient,
  delta: DeclaredProjectionDelta
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const executionChange = delta.tables.find((table) => table.declaration.projection.table === "execution_projection");
    if (!executionChange) return;
    yield* createExecutionEvidenceProjectionTables(sql);
    yield* createExecutionEvidenceIndexes(sql);
    const changedExecutionIds = new Set([
      ...executionChange.deletePrimaryKeys,
      ...executionChange.upsertRows.map(executionId)
    ]);
    for (const id of changedExecutionIds) {
      yield* sql`DELETE FROM execution_evidence_projection WHERE execution_id = ${id}`;
      yield* sql`DELETE FROM execution_output_projection WHERE execution_id = ${id}`;
    }
    const summaries = executionChange.upsertRows.map(executionSummary);
    for (const rows of chunks(summaries, 250)) yield* insertExecutionSummaryRows(sql, rows);
    const outputs = executionChange.upsertRows.flatMap(executionOutputs);
    for (const rows of chunks(outputs, 250)) yield* insertExecutionOutputRows(sql, rows);
  });
}

export function hashExecutionEvidenceProjectionState(
  sql: SqlClient.SqlClient
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const executions = yield* sql<Record<string, unknown>>`
      SELECT execution_id, task_ref, state, executor_id, executor_kind,
             responsible_human, claimed_at, submitted_at, closed_at, latest_at, archival
      FROM execution_evidence_projection
      ORDER BY execution_id
    `;
    const outputs = yield* sql<Record<string, unknown>>`
      SELECT execution_id, ordinal, evidence_id, execution_ref, substrate,
             inline_text, file_path, url, object_ref, object_sha256, object_size,
             object_media_type, entity_ref, checker_id, checker_version,
             target_evidence_id, target_sha256, checked_at, receipt_result,
             evidence_sha256, checker_receipt_ref
      FROM execution_output_projection
      ORDER BY execution_id, ordinal
    `;
    return stablePayloadHash({
      schema: "execution-evidence-projection-state/v1",
      executions,
      outputs
    });
  });
}

function createExecutionEvidenceProjectionTables(sql: SqlClient.SqlClient): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* sql`
      CREATE TABLE IF NOT EXISTS execution_evidence_projection (
        execution_id TEXT PRIMARY KEY,
        task_ref TEXT NOT NULL,
        state TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        executor_kind TEXT NOT NULL,
        responsible_human TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        submitted_at TEXT,
        closed_at TEXT,
        latest_at TEXT NOT NULL,
        archival INTEGER NOT NULL CHECK (archival IN (0, 1))
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS execution_output_projection (
        execution_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        evidence_id TEXT NOT NULL,
        execution_ref TEXT NOT NULL,
        substrate TEXT NOT NULL,
        inline_text TEXT,
        file_path TEXT,
        url TEXT,
        object_ref TEXT,
        object_sha256 TEXT,
        object_size INTEGER,
        object_media_type TEXT,
        entity_ref TEXT,
        checker_id TEXT,
        checker_version TEXT,
        target_evidence_id TEXT,
        target_sha256 TEXT,
        checked_at TEXT,
        receipt_result TEXT,
        evidence_sha256 TEXT,
        checker_receipt_ref TEXT,
        PRIMARY KEY (execution_id, evidence_id),
        UNIQUE (execution_id, ordinal)
      )
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS execution_output_projection_execution_ordinal
      ON execution_output_projection (execution_id, ordinal)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS execution_output_projection_receipt
      ON execution_output_projection (substrate, receipt_result)
    `;
  });
}

function createExecutionEvidenceIndexes(sql: SqlClient.SqlClient): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* sql`
      CREATE INDEX IF NOT EXISTS execution_evidence_projection_latest
      ON execution_evidence_projection (latest_at DESC, execution_id ASC)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS execution_evidence_projection_task
      ON execution_evidence_projection (task_ref, latest_at DESC, execution_id ASC)
    `;
  });
}

interface ExecutionSummaryInsertRow {
  readonly executionId: string;
  readonly taskRef: string;
  readonly state: string;
  readonly executorId: string;
  readonly executorKind: string;
  readonly responsibleHuman: string;
  readonly claimedAt: string;
  readonly submittedAt: string | null;
  readonly closedAt: string | null;
  readonly latestAt: string;
  readonly archival: number;
}

interface ExecutionOutputInsertRow {
  readonly executionId: string;
  readonly ordinal: number;
  readonly evidenceId: string;
  readonly executionRef: string;
  readonly substrate: string;
  readonly inlineText: string | null;
  readonly filePath: string | null;
  readonly url: string | null;
  readonly objectRef: string | null;
  readonly objectSha256: string | null;
  readonly objectSize: number | null;
  readonly objectMediaType: string | null;
  readonly entityRef: string | null;
  readonly checkerId: string | null;
  readonly checkerVersion: string | null;
  readonly targetEvidenceId: string | null;
  readonly targetSha256: string | null;
  readonly checkedAt: string | null;
  readonly receiptResult: string | null;
  readonly evidenceSha256: string | null;
  readonly checkerReceiptRef: string | null;
}

function executionSummary(row: DeclaredProjectionRow): ExecutionSummaryInsertRow {
  const actor = decodeJsonObject(row.primary_actor_json, "primary_actor_json");
  const executor = jsonObject(actor.executor);
  const claimedAt = requiredString(row.claimed_at, "claimed_at");
  const submittedAt = optionalString(row.submitted_at);
  const executorId = typeof executor?.id === "string" ? executor.id : "";
  return {
    executionId: executionId(row),
    taskRef: requiredString(row.task_ref, "task_ref"),
    state: requiredString(row.state, "state"),
    executorId,
    executorKind: typeof executor?.kind === "string" ? executor.kind : "",
    responsibleHuman: typeof actor.responsibleHuman === "string" ? actor.responsibleHuman : "",
    claimedAt,
    submittedAt,
    closedAt: optionalString(row.closed_at),
    latestAt: submittedAt ?? claimedAt,
    archival: executorId === "fact-execution-migration" ? 1 : 0
  };
}

function executionOutputs(
  row: DeclaredProjectionRow
): ReadonlyArray<ExecutionOutputInsertRow> {
  const id = executionId(row);
  return decodeOutputs(row.outputs_json).map((output, ordinal) => {
    const locator = output.locator;
    const receipt = locator.substrate === "checker_receipt" ? locator.receipt : null;
    return {
      executionId: id,
      ordinal,
      evidenceId: output.evidence_id,
      executionRef: output.execution_ref,
      substrate: locator.substrate,
      inlineText: locator.substrate === "inline" ? locator.text : null,
      filePath: locator.substrate === "file" ? locator.path : null,
      url: locator.substrate === "url" ? locator.url : null,
      objectRef: locator.substrate === "object" ? locator.ref : null,
      objectSha256: locator.substrate === "object" ? locator.sha256 : null,
      objectSize: locator.substrate === "object" ? locator.size : null,
      objectMediaType: locator.substrate === "object" ? locator.media_type : null,
      entityRef: locator.substrate === "entity" ? locator.entity_ref : null,
      checkerId: receipt?.checker_id ?? null,
      checkerVersion: receipt?.checker_version ?? null,
      targetEvidenceId: receipt?.target_evidence_id ?? null,
      targetSha256: receipt?.target_sha256 ?? null,
      checkedAt: receipt?.checked_at ?? null,
      receiptResult: receipt?.result ?? null,
      evidenceSha256: output.sha256 ?? null,
      checkerReceiptRef: output.checker_receipt_ref ?? null
    };
  });
}

function insertExecutionOutputRows(
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<ExecutionOutputInsertRow>
): Effect.Effect<unknown, unknown> {
  return sql.unsafe(`
    INSERT INTO execution_output_projection (
      execution_id, ordinal, evidence_id, execution_ref, substrate,
      inline_text, file_path, url, object_ref, object_sha256, object_size,
      object_media_type, entity_ref, checker_id, checker_version,
      target_evidence_id, target_sha256, checked_at, receipt_result,
      evidence_sha256, checker_receipt_ref
    ) VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
  `, rows.flatMap((row) => [
    row.executionId, row.ordinal, row.evidenceId, row.executionRef, row.substrate,
    row.inlineText, row.filePath, row.url, row.objectRef, row.objectSha256,
    row.objectSize, row.objectMediaType, row.entityRef, row.checkerId,
    row.checkerVersion, row.targetEvidenceId, row.targetSha256, row.checkedAt,
    row.receiptResult, row.evidenceSha256, row.checkerReceiptRef
  ]));
}

function insertExecutionSummaryRows(
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<ExecutionSummaryInsertRow>
): Effect.Effect<unknown, unknown> {
  return sql.unsafe(`
    INSERT INTO execution_evidence_projection (
      execution_id, task_ref, state, executor_id, executor_kind,
      responsible_human, claimed_at, submitted_at, closed_at, latest_at, archival
    ) VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
  `, rows.flatMap((row) => [
    row.executionId, row.taskRef, row.state, row.executorId, row.executorKind,
    row.responsibleHuman, row.claimedAt, row.submittedAt, row.closedAt,
    row.latestAt, row.archival
  ]));
}

function executionId(row: DeclaredProjectionRow): string {
  const value = row.execution_id;
  if (typeof value !== "string" || value.length === 0) throw new Error("execution projection row is missing execution_id");
  return value;
}

function decodeOutputs(value: DeclaredProjectionRow[string]): ReadonlyArray<OutputEvidence> {
  if (typeof value !== "string") throw new Error("execution projection row is missing outputs_json");
  const decoded: unknown = JSON.parse(value);
  if (!Array.isArray(decoded)) throw new Error("execution projection outputs_json must be an array");
  return decoded as ReadonlyArray<OutputEvidence>;
}

function decodeJsonObject(value: DeclaredProjectionRow[string], field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "string") throw new Error(`execution projection row is missing ${field}`);
  const decoded: unknown = JSON.parse(value);
  const object = jsonObject(decoded);
  if (!object) throw new Error(`execution projection ${field} must be an object`);
  return object;
}

function jsonObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function requiredString(value: DeclaredProjectionRow[string], field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`execution projection row is missing ${field}`);
  return value;
}

function optionalString(value: DeclaredProjectionRow[string]): string | null {
  return typeof value === "string" ? value : null;
}

function chunks<Value>(values: ReadonlyArray<Value>, size: number): ReadonlyArray<ReadonlyArray<Value>> {
  const output: Value[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

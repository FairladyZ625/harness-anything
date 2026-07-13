import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutOverrides } from "../layout/index.ts";
import { defaultTaskProjectionPath, readTaskProjection } from "./sqlite-task-projection.ts";

export interface ExecutionEvidenceCursor {
  readonly generation: string;
  readonly latestAt: string;
  readonly executionId: string;
}

export interface ExecutionEvidenceOutputRow {
  readonly evidenceId: string;
  readonly text: string;
  readonly substrate: string;
  readonly hasPassingReceipt: boolean;
  readonly hasReceiptRef: boolean;
}

export interface ExecutionEvidenceExecutionRow {
  readonly executionId: string;
  readonly taskRef: string;
  readonly taskId: string;
  readonly state: string;
  readonly executorId: string;
  readonly executorKind: string;
  readonly responsibleHuman: string;
  readonly claimedAt: string;
  readonly submittedAt: string | null;
  readonly closedAt: string | null;
  readonly outputs: ReadonlyArray<ExecutionEvidenceOutputRow>;
  readonly outputCount: number;
  readonly hasMoreOutputs: boolean;
  readonly hasAnyPassingReceipt: boolean;
  readonly archival: boolean;
}

export interface ExecutionEvidenceTaskGroup {
  readonly taskId: string;
  readonly title: string;
  readonly latestAt: string;
  readonly executions: ReadonlyArray<ExecutionEvidenceExecutionRow>;
}

export interface ExecutionEvidenceStats {
  readonly totalExecutions: number;
  readonly archivalExecutions: number;
  readonly realExecutions: number;
  readonly totalOutputs: number;
  readonly passingReceiptOutputs: number;
  readonly tasksWithExecutions: number;
}

export interface ExecutionEvidencePage {
  readonly groups: ReadonlyArray<ExecutionEvidenceTaskGroup>;
  readonly stats: ExecutionEvidenceStats;
  readonly nextCursor: ExecutionEvidenceCursor | null;
}

interface ExecutionEvidencePageOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly limit: number;
  readonly cursor?: ExecutionEvidenceCursor;
}

export function queryExecutionEvidencePage(
  options: ExecutionEvidencePageOptions
): ExecutionEvidencePage {
  const db = openFreshExecutionEvidenceProjection(options);
  try {
    return readExecutionEvidencePage(db, options);
  } finally {
    db.close();
  }
}

// Internal benchmark/daemon seam. Callers must establish projection freshness first.
export function queryExecutionEvidencePageFromReadyProjection(
  options: ExecutionEvidencePageOptions
): ExecutionEvidencePage {
  const db = new DatabaseSync(executionEvidenceProjectionPath(options), { readOnly: true });
  try {
    return readExecutionEvidencePage(db, options);
  } finally {
    db.close();
  }
}

function readExecutionEvidencePage(db: DatabaseSync, options: ExecutionEvidencePageOptions): ExecutionEvidencePage {
  const limit = executionEvidencePageLimit(options.limit);
  const cursor = options.cursor;
  if (cursor) validateExecutionEvidenceCursor(cursor);
  const generation = readExecutionEvidenceGeneration(db);
  if (cursor && cursor.generation !== generation) {
    throw new Error("execution evidence cursor generation changed; restart pagination from the first page");
  }
  const executionRows = db.prepare(`
      SELECT execution.execution_id, execution.task_ref, execution.state,
             substr(execution.executor_id, 1, 128) AS executor_id,
             substr(execution.executor_kind, 1, 128) AS executor_kind,
             substr(execution.responsible_human, 1, 128) AS responsible_human,
             execution.claimed_at, execution.submitted_at, execution.closed_at,
             execution.latest_at, execution.archival,
             substr(COALESCE(task.title, substr(execution.task_ref, 6)), 1, 256) AS task_title
      FROM execution_evidence_projection AS execution
      LEFT JOIN task_projection AS task ON task.task_id = substr(execution.task_ref, 6)
      WHERE (? IS NULL OR execution.latest_at < ?
             OR (execution.latest_at = ? AND execution.execution_id > ?))
      ORDER BY latest_at DESC, execution.execution_id ASC
      LIMIT ?
  `).all(
    cursor?.latestAt ?? null,
    cursor?.latestAt ?? null,
    cursor?.latestAt ?? null,
    cursor?.executionId ?? null,
    limit + 1
  ) as Array<Record<string, unknown>>;
  const hasNextPage = executionRows.length > limit;
  const visibleExecutionRows = executionRows.slice(0, limit);
  const executionIds = visibleExecutionRows.map((row) => String(row.execution_id));
  const outputRows = executionIds.length === 0 ? [] : db.prepare(`
      SELECT * FROM (
        SELECT execution_id, ordinal, evidence_id, substrate,
               substr(inline_text, 1, 256) AS inline_text,
               CASE WHEN length(inline_text) > 256 THEN 1 ELSE 0 END AS inline_text_truncated,
               substr(file_path, 1, 256) AS file_path,
               substr(url, 1, 256) AS url,
               substr(object_ref, 1, 256) AS object_ref,
               substr(entity_ref, 1, 256) AS entity_ref,
               CASE WHEN length(COALESCE(file_path, url, object_ref, entity_ref, '')) > 256
                    THEN 1 ELSE 0 END AS detail_truncated,
               receipt_result,
               checker_receipt_ref,
               COUNT(*) OVER (PARTITION BY execution_id) AS total_output_count,
               SUM(CASE WHEN substrate = 'checker_receipt' AND receipt_result = 'pass' THEN 1 ELSE 0 END)
                 OVER (PARTITION BY execution_id) AS passing_output_count,
               ROW_NUMBER() OVER (
                 PARTITION BY execution_id
                 ORDER BY CASE WHEN substrate = 'checker_receipt' AND receipt_result = 'pass' THEN 1 ELSE 0 END,
                          ordinal
               ) AS output_rank
        FROM execution_output_projection
        WHERE execution_id IN (${sqlPlaceholders(executionIds.length)})
      )
      WHERE output_rank <= 5
      ORDER BY execution_id, output_rank
  `).all(...executionIds) as Array<Record<string, unknown>>;
  const outputsByExecution = groupExecutionEvidenceOutputs(outputRows);
  const outputCounts = new Map(outputRows.map((row) => [String(row.execution_id), Number(row.total_output_count)]));
  const passingOutputCounts = new Map(outputRows.map((row) => [String(row.execution_id), Number(row.passing_output_count)]));
  const groups: ExecutionEvidenceTaskGroup[] = [];
  const groupExecutionsByTask = new Map<string, ExecutionEvidenceExecutionRow[]>();
  for (const row of visibleExecutionRows) {
    const executionId = String(row.execution_id);
    const execution = toExecutionEvidence(
      row,
      outputsByExecution.get(executionId) ?? [],
      outputCounts.get(executionId) ?? 0,
      (passingOutputCounts.get(executionId) ?? 0) > 0
    );
    const existingExecutions = groupExecutionsByTask.get(execution.taskId);
    if (existingExecutions) {
      existingExecutions.push(execution);
      continue;
    }
    const executions = [execution];
    const group = {
      taskId: execution.taskId,
      title: String(row.task_title),
      latestAt: String(row.latest_at),
      executions
    } satisfies ExecutionEvidenceTaskGroup;
    groups.push(group);
    groupExecutionsByTask.set(group.taskId, executions);
  }
  const last = visibleExecutionRows.at(-1);
  return {
    groups,
    stats: readExecutionEvidenceStats(db),
    nextCursor: hasNextPage && last ? {
      generation,
      latestAt: String(last.latest_at),
      executionId: String(last.execution_id)
    } : null
  };
}

function openFreshExecutionEvidenceProjection(options: ExecutionEvidencePageOptions): DatabaseSync {
  const rootDir = path.resolve(options.rootDir);
  readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides });
  return new DatabaseSync(executionEvidenceProjectionPath(options), { readOnly: true });
}

function executionEvidenceProjectionPath(options: ExecutionEvidencePageOptions): string {
  return options.layoutOverrides
    ? resolveHarnessLayout({ rootDir: path.resolve(options.rootDir), layoutOverrides: options.layoutOverrides }).projectionPath
    : defaultTaskProjectionPath(path.resolve(options.rootDir));
}

function toExecutionEvidence(
  row: Record<string, unknown>,
  outputs: ReadonlyArray<ExecutionEvidenceOutputRow>,
  outputCount: number,
  hasAnyPassingReceipt: boolean
): ExecutionEvidenceExecutionRow {
  const taskRef = String(row.task_ref);
  const executorId = String(row.executor_id);
  return {
    executionId: String(row.execution_id),
    taskRef,
    taskId: executionEvidenceEntityId(taskRef, "task/") ?? taskRef,
    state: String(row.state),
    executorId,
    executorKind: String(row.executor_kind),
    responsibleHuman: String(row.responsible_human),
    claimedAt: String(row.claimed_at),
    submittedAt: nullableEvidenceString(row.submitted_at),
    closedAt: nullableEvidenceString(row.closed_at),
    outputs,
    outputCount,
    hasMoreOutputs: outputCount > outputs.length,
    hasAnyPassingReceipt,
    archival: row.archival === 1
  };
}

function groupExecutionEvidenceOutputs(
  rows: ReadonlyArray<Record<string, unknown>>
): ReadonlyMap<string, ReadonlyArray<ExecutionEvidenceOutputRow>> {
  const grouped = new Map<string, ExecutionEvidenceOutputRow[]>();
  for (const row of rows) {
    const executionId = String(row.execution_id);
    const values = grouped.get(executionId) ?? [];
    values.push(toExecutionEvidenceOutput(row));
    grouped.set(executionId, values);
  }
  return grouped;
}

function toExecutionEvidenceOutput(row: Record<string, unknown>): ExecutionEvidenceOutputRow {
  const substrate = String(row.substrate);
  const hasPassingReceipt = substrate === "checker_receipt" && row.receipt_result === "pass";
  return {
    evidenceId: String(row.evidence_id),
    text: executionEvidenceOutputText(row, substrate),
    substrate,
    hasPassingReceipt,
    hasReceiptRef: hasPassingReceipt || (typeof row.checker_receipt_ref === "string" && row.checker_receipt_ref.length > 0)
  };
}

function executionEvidenceOutputText(row: Record<string, unknown>, substrate: string): string {
  if (substrate === "inline" && typeof row.inline_text === "string") {
    return row.inline_text_truncated === 1 ? `${row.inline_text}…` : row.inline_text;
  }
  const detail = substrate === "file" ? row.file_path
    : substrate === "url" ? row.url
    : substrate === "object" ? row.object_ref
    : substrate === "entity" ? row.entity_ref
    : null;
  if (typeof detail !== "string" || detail.length === 0) return `[${substrate}]`;
  return `[${substrate}] ${detail}${row.detail_truncated === 1 ? "…" : ""}`;
}

function readExecutionEvidenceStats(db: DatabaseSync): ExecutionEvidenceStats {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM execution_evidence_projection) AS total_executions,
      (SELECT COUNT(*) FROM execution_evidence_projection WHERE archival = 1) AS archival_executions,
      (SELECT COUNT(*) FROM execution_evidence_projection WHERE archival = 0) AS real_executions,
      (SELECT COUNT(*) FROM execution_output_projection) AS total_outputs,
      (SELECT COUNT(*) FROM execution_output_projection
       WHERE substrate = 'checker_receipt' AND receipt_result = 'pass') AS passing_receipt_outputs,
      (SELECT COUNT(DISTINCT task_ref) FROM execution_evidence_projection) AS tasks_with_executions
  `).get() as Record<string, unknown>;
  return {
    totalExecutions: Number(row.total_executions),
    archivalExecutions: Number(row.archival_executions),
    realExecutions: Number(row.real_executions),
    totalOutputs: Number(row.total_outputs),
    passingReceiptOutputs: Number(row.passing_receipt_outputs),
    tasksWithExecutions: Number(row.tasks_with_executions)
  };
}

function executionEvidencePageLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("execution evidence page limit must be an integer between 1 and 100");
  }
  return value;
}

function validateExecutionEvidenceCursor(cursor: ExecutionEvidenceCursor): void {
  if (!cursor.generation || !cursor.latestAt || !Number.isFinite(Date.parse(cursor.latestAt)) || !cursor.executionId) {
    throw new Error("execution evidence cursor is invalid");
  }
}

function readExecutionEvidenceGeneration(db: DatabaseSync): string {
  const row = db.prepare("SELECT value FROM projection_meta WHERE key = 'sourceHash'").get() as { readonly value?: unknown } | undefined;
  if (!row || typeof row.value !== "string" || row.value.length === 0) {
    throw new Error("execution evidence projection generation is missing");
  }
  return row.value;
}

function nullableEvidenceString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function executionEvidenceEntityId(value: string, prefix: string): string | null {
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

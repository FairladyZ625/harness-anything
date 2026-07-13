import type {
  ExecutionEvidenceCursor,
  ExecutionEvidenceExecutionRow,
  ExecutionEvidenceOutputRow,
  ExecutionEvidencePageResult,
  ExecutionEvidenceStats,
  ExecutionEvidenceTaskGroup
} from "../api/renderer-dto.ts";

export interface ExecutionEvidencePageSuccess {
  readonly ok: true;
  readonly groups: ReadonlyArray<ExecutionEvidenceTaskGroup>;
  readonly stats: ExecutionEvidenceStats;
  readonly nextCursor: ExecutionEvidenceCursor | null;
}

export function readExecutionEvidencePageResult(value: unknown): ExecutionEvidencePageSuccess {
  const result = value as ExecutionEvidencePageResult;
  if (!result || typeof result !== "object" || result.ok !== true ||
      !Array.isArray(result.groups) || !isExecutionEvidenceStats(result.stats) ||
      (result.nextCursor !== null && !isExecutionEvidenceCursor(result.nextCursor))) {
    throw new Error(executionEvidenceErrorHint(value));
  }
  if (!result.groups.every(isExecutionEvidenceTaskGroup)) {
    throw new Error("Execution evidence page bridge returned rows outside the page DTO.");
  }
  return {
    ok: true,
    groups: result.groups,
    stats: result.stats,
    nextCursor: result.nextCursor
  };
}

function isExecutionEvidenceTaskGroup(value: unknown): value is ExecutionEvidenceTaskGroup {
  return Boolean(
    value && typeof value === "object" &&
    typeof (value as ExecutionEvidenceTaskGroup).taskId === "string" &&
    typeof (value as ExecutionEvidenceTaskGroup).title === "string" &&
    typeof (value as ExecutionEvidenceTaskGroup).latestAt === "string" &&
    Number.isFinite(Date.parse((value as ExecutionEvidenceTaskGroup).latestAt)) &&
    Array.isArray((value as ExecutionEvidenceTaskGroup).executions) &&
    (value as ExecutionEvidenceTaskGroup).executions.every(isExecutionEvidenceExecutionRow)
  );
}

function isExecutionEvidenceExecutionRow(value: unknown): value is ExecutionEvidenceExecutionRow {
  return Boolean(
    value && typeof value === "object" &&
    typeof (value as ExecutionEvidenceExecutionRow).executionId === "string" &&
    typeof (value as ExecutionEvidenceExecutionRow).taskId === "string" &&
    typeof (value as ExecutionEvidenceExecutionRow).taskRef === "string" &&
    typeof (value as ExecutionEvidenceExecutionRow).state === "string" &&
    typeof (value as ExecutionEvidenceExecutionRow).executorId === "string" &&
    typeof (value as ExecutionEvidenceExecutionRow).executorKind === "string" &&
    typeof (value as ExecutionEvidenceExecutionRow).responsibleHuman === "string" &&
    typeof (value as ExecutionEvidenceExecutionRow).claimedAt === "string" &&
    Number.isFinite(Date.parse((value as ExecutionEvidenceExecutionRow).claimedAt)) &&
    isNullableEvidenceString((value as ExecutionEvidenceExecutionRow).submittedAt) &&
    isNullableEvidenceString((value as ExecutionEvidenceExecutionRow).closedAt) &&
    typeof (value as ExecutionEvidenceExecutionRow).archival === "boolean" &&
    Number.isInteger((value as ExecutionEvidenceExecutionRow).outputCount) &&
    (value as ExecutionEvidenceExecutionRow).outputCount >= 0 &&
    typeof (value as ExecutionEvidenceExecutionRow).hasMoreOutputs === "boolean" &&
    typeof (value as ExecutionEvidenceExecutionRow).hasAnyPassingReceipt === "boolean" &&
    Array.isArray((value as ExecutionEvidenceExecutionRow).outputs) &&
    (value as ExecutionEvidenceExecutionRow).outputs.every(isExecutionEvidenceOutputRow)
  );
}

function isExecutionEvidenceOutputRow(value: unknown): value is ExecutionEvidenceOutputRow {
  return Boolean(
    value && typeof value === "object" &&
    typeof (value as ExecutionEvidenceOutputRow).evidenceId === "string" &&
    typeof (value as ExecutionEvidenceOutputRow).text === "string" &&
    typeof (value as ExecutionEvidenceOutputRow).substrate === "string" &&
    typeof (value as ExecutionEvidenceOutputRow).hasPassingReceipt === "boolean" &&
    typeof (value as ExecutionEvidenceOutputRow).hasReceiptRef === "boolean"
  );
}

function isExecutionEvidenceStats(value: unknown): value is ExecutionEvidenceStats {
  if (!value || typeof value !== "object") return false;
  const stats = value as ExecutionEvidenceStats;
  return [
    stats.totalExecutions,
    stats.archivalExecutions,
    stats.realExecutions,
    stats.totalOutputs,
    stats.passingReceiptOutputs,
    stats.tasksWithExecutions
  ].every((count) => Number.isInteger(count) && count >= 0);
}

function isExecutionEvidenceCursor(value: unknown): value is ExecutionEvidenceCursor {
  return Boolean(
    value && typeof value === "object" &&
    typeof (value as ExecutionEvidenceCursor).generation === "string" &&
    (value as ExecutionEvidenceCursor).generation.length > 0 &&
    typeof (value as ExecutionEvidenceCursor).latestAt === "string" &&
    Number.isFinite(Date.parse((value as ExecutionEvidenceCursor).latestAt)) &&
    typeof (value as ExecutionEvidenceCursor).executionId === "string"
  );
}

function isNullableEvidenceString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function executionEvidenceErrorHint(value: unknown): string {
  if (value && typeof value === "object" && "ok" in value && (value as { ok: unknown }).ok === false) {
    const error = (value as { error?: { hint?: unknown } }).error;
    if (typeof error?.hint === "string" && error.hint.length > 0) return error.hint;
  }
  return "Execution evidence page bridge returned an invalid result.";
}

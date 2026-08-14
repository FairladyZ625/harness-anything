import type { TaskSnapshotProjectionRow } from "../../api/renderer-dto.ts";

export const EXECUTION_EVIDENCE_PAGE_SIZE = 25;
export const UNKNOWN_EVIDENCE_FIELD = "unknown / 未投影";

type Snapshot = TaskSnapshotProjectionRow["snapshot"];
type Execution = Snapshot["executions"][number];
type Review = Snapshot["reviews"][number];
type Consent = Snapshot["consents"][number];
type GateWitness = Snapshot["gateWitnesses"][number];
type ProjectedEvidence = TaskSnapshotProjectionRow["executionEvidence"][number];
type ProjectedOutput = ProjectedEvidence["outputs"][number];

export interface ExecutionEvidenceOutput {
  readonly evidenceId?: string;
  readonly locator?: string;
  readonly substrate?: "repository-path" | "uri" | "canonical-event" | "opaque";
  readonly checkerReceiptRef?: string | null;
  readonly checkerResult?: "pass" | "fail" | "unknown";
  readonly isPassingReceipt: boolean;
  readonly raw: unknown;
}

export interface ExecutionEvidenceRow {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskUpdatedAt: string;
  readonly executionId: string;
  readonly state?: string;
  readonly iteration?: number;
  readonly commitSha?: string;
  readonly claimedAt?: string;
  readonly submittedAt?: string | null;
  readonly closedAt?: string | null;
  readonly origin?: "native" | "archival";
  readonly outputs: readonly ExecutionEvidenceOutput[];
  readonly reviews: readonly Review[];
  readonly consents: readonly Consent[];
  readonly gateWitnesses: readonly GateWitness[];
  readonly witnessAvailability: TaskSnapshotProjectionRow["snapshotAvailability"];
  readonly rawTask: unknown;
  readonly rawExecution: unknown;
}

export interface ExecutionEvidenceStats {
  readonly executions: number;
  readonly tasksWithExecutions: number;
  readonly outputs: number;
  readonly nativeExecutions: number;
  readonly archivalExecutions: number;
  readonly unknownOriginExecutions: number;
  readonly passingReceiptOutputs: number;
}

export interface ExecutionEvidenceModel {
  readonly executions: readonly ExecutionEvidenceRow[];
  readonly stats: ExecutionEvidenceStats;
}

export interface ExecutionEvidenceFilters {
  readonly receipt: "all" | "passing" | "no-receipt";
  readonly origin: "all" | "native" | "archival";
}

export interface ExecutionEvidencePage {
  readonly executions: readonly ExecutionEvidenceRow[];
  readonly pageNumber: number;
  readonly totalPages: number;
  readonly hasPreviousPage: boolean;
  readonly hasNextPage: boolean;
}

export function aggregateExecutionEvidence(rows: readonly TaskSnapshotProjectionRow[]): ExecutionEvidenceModel {
  const executions = rows.flatMap(adaptTaskExecutions).sort(compareExecutions);
  const taskIds = new Set(executions.map(({ taskId }) => taskId));
  return {
    executions,
    stats: {
      executions: executions.length,
      tasksWithExecutions: taskIds.size,
      outputs: executions.reduce((total, item) => total + item.outputs.length, 0),
      nativeExecutions: executions.filter(({ origin }) => origin === "native").length,
      archivalExecutions: executions.filter(({ origin }) => origin === "archival").length,
      unknownOriginExecutions: executions.filter(({ origin }) => origin === undefined).length,
      passingReceiptOutputs: executions.reduce((total, item) => total + item.outputs.filter(({ isPassingReceipt }) => isPassingReceipt).length, 0),
    },
  };
}

export function filterExecutionEvidence(
  executions: readonly ExecutionEvidenceRow[],
  filters: ExecutionEvidenceFilters,
): ExecutionEvidenceRow[] {
  return executions.flatMap((execution) => {
    if (filters.origin !== "all" && execution.origin !== filters.origin) return [];
    if (filters.receipt === "all") return [execution];
    const outputs = execution.outputs.filter((output) => filters.receipt === "passing"
      ? output.isPassingReceipt
      : output.checkerReceiptRef === null);
    return outputs.length > 0 ? [{ ...execution, outputs }] : [];
  });
}

export function paginateExecutionEvidence(
  executions: readonly ExecutionEvidenceRow[],
  requestedPageIndex: number,
): ExecutionEvidencePage {
  const totalPages = Math.max(1, Math.ceil(executions.length / EXECUTION_EVIDENCE_PAGE_SIZE));
  const pageIndex = Math.min(Math.max(0, requestedPageIndex), totalPages - 1);
  const start = pageIndex * EXECUTION_EVIDENCE_PAGE_SIZE;
  return {
    executions: executions.slice(start, start + EXECUTION_EVIDENCE_PAGE_SIZE),
    pageNumber: pageIndex + 1,
    totalPages,
    hasPreviousPage: pageIndex > 0,
    hasNextPage: pageIndex + 1 < totalPages,
  };
}

export function buildExecutionEvidenceContext(
  execution: ExecutionEvidenceRow,
  output: ExecutionEvidenceOutput,
  now: () => string = () => new Date().toISOString(),
): string {
  return [
    "# Harness 执行证据上下文",
    "",
    `copiedAt: ${now()}`,
    `taskId: ${execution.taskId}`,
    `executionId: ${execution.executionId}`,
    `iteration: ${field(execution.iteration)}`,
    `commitSha: ${field(execution.commitSha)}`,
    `origin: ${field(execution.origin)}`,
    `evidenceId: ${field(output.evidenceId)}`,
    `substrate: ${field(output.substrate)}`,
    `locator: ${field(output.locator)}`,
    `checkerReceiptRef: ${receiptField(output.checkerReceiptRef)}`,
    `checkerResult: ${checkerResultField(output.checkerResult)}`,
    "",
    "## task 原文",
    json(execution.rawTask),
    "",
    "## execution 原文",
    json(execution.rawExecution),
    "",
    "## output 原文",
    json(output.raw),
  ].join("\n");
}

export function field(value: unknown): string {
  return value === undefined || value === null || value === "" ? UNKNOWN_EVIDENCE_FIELD : String(value);
}

export function receiptField(value: string | null | undefined): string {
  return value === null ? "none / 无 receipt" : field(value);
}

export function checkerResultField(value: ExecutionEvidenceOutput["checkerResult"]): string {
  return value === "unknown" ? UNKNOWN_EVIDENCE_FIELD : field(value);
}

function adaptTaskExecutions(row: TaskSnapshotProjectionRow): ExecutionEvidenceRow[] {
  const taskTitle = row.snapshot.task?.title ?? row.taskId;
  return row.snapshot.executions.map((execution) => adaptExecution(row, execution, taskTitle));
}

function adaptExecution(row: TaskSnapshotProjectionRow, execution: Execution, taskTitle: string): ExecutionEvidenceRow {
  const projections = row.executionEvidence.filter((item) => item.executionId === execution.executionId);
  const projection = projections.length === 1 ? projections[0] : undefined;
  const commitSha = text(execution.submission?.commitSha);
  const iteration = Number.isInteger(execution.iteration) ? execution.iteration : undefined;
  const reviews = commitSha === undefined || iteration === undefined ? [] : row.snapshot.reviews.filter((review) =>
    review.executionId === execution.executionId && review.commitSha === commitSha && review.iteration === iteration);
  const reviewIds = new Set(reviews.map(({ reviewId }) => reviewId));
  const consents = row.snapshot.consents.filter((consent) =>
    consent.executionId === execution.executionId && reviewIds.has(consent.reviewId));
  const gateWitnesses = commitSha === undefined || iteration === undefined ? [] : row.snapshot.gateWitnesses.filter((witness) =>
    witness.executionId === execution.executionId && witness.commitSha === commitSha && witness.iteration === iteration);
  return {
    taskId: row.taskId,
    taskTitle,
    taskUpdatedAt: row.updatedAt,
    executionId: execution.executionId,
    state: text(execution.state),
    iteration,
    commitSha,
    claimedAt: text(execution.claimedAt),
    submittedAt: nullableText(execution.submittedAt),
    closedAt: nullableText(execution.closedAt),
    origin: projection?.origin === "native" || projection?.origin === "archival" ? projection.origin : undefined,
    outputs: adaptOutputs(execution, projection),
    reviews,
    consents,
    gateWitnesses,
    witnessAvailability: row.snapshotAvailability,
    rawTask: row.snapshot.task,
    rawExecution: execution,
  };
}

function adaptOutputs(execution: Execution, projection: ProjectedEvidence | undefined): ExecutionEvidenceOutput[] {
  const projected = projection?.outputs ?? [];
  const submitted = execution.submission?.outputs ?? [];
  const count = Math.max(projected.length, submitted.length);
  return Array.from({ length: count }, (_, index) => adaptOutput(projected[index], submitted[index]));
}

function adaptOutput(output: ProjectedOutput | undefined, submittedLocator: string | undefined): ExecutionEvidenceOutput {
  const candidate = output as Partial<ProjectedOutput> | undefined;
  const checkerReceiptRef = candidate?.checkerReceiptRef === null ? null : text(candidate?.checkerReceiptRef);
  const checkerResult = candidate?.checkerResult === "pass" || candidate?.checkerResult === "fail" || candidate?.checkerResult === "unknown"
    ? candidate.checkerResult : undefined;
  return {
    evidenceId: text(candidate?.evidenceId),
    locator: text(candidate?.locator),
    substrate: candidate?.substrate === "repository-path" || candidate?.substrate === "uri"
      || candidate?.substrate === "canonical-event" || candidate?.substrate === "opaque" ? candidate.substrate : undefined,
    checkerReceiptRef,
    checkerResult,
    isPassingReceipt: checkerReceiptRef !== undefined && checkerReceiptRef !== null && checkerResult === "pass",
    raw: { submission: submittedLocator, projection: output ?? null },
  };
}

function compareExecutions(left: ExecutionEvidenceRow, right: ExecutionEvidenceRow): number {
  const byTime = latestStamp(right).localeCompare(latestStamp(left));
  if (byTime !== 0) return byTime;
  const byTask = left.taskId.localeCompare(right.taskId);
  return byTask !== 0 ? byTask : left.executionId.localeCompare(right.executionId);
}

function latestStamp(execution: ExecutionEvidenceRow): string {
  return execution.closedAt ?? execution.submittedAt ?? execution.claimedAt ?? execution.taskUpdatedAt;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableText(value: unknown): string | null | undefined {
  return value === null ? null : text(value);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? UNKNOWN_EVIDENCE_FIELD;
}

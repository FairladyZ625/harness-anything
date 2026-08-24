import type { TaskSnapshotProjectionRow } from "../../api/renderer-dto.ts";

// W5:全局「执行证据」列表页撤销,execution 输出/回执的渲染并入 Task 详情
// 「收口」页签。本模块只保留单 task 的投影适配与上下文拼装;跨 task 的
// 聚合统计/过滤/分页随页面一并删除(那是列表页的机制,不是数据面)。

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
  readonly selectedReviewId: string | null;
  readonly selectedConsentId: string | null;
  readonly gateWitnesses: readonly GateWitness[];
  readonly witnessAvailability?: TaskSnapshotProjectionRow["snapshotAvailability"];
  readonly rawTask: unknown;
  readonly rawExecution: unknown;
}

/**
 * 适配所需的最小行形状:TaskSnapshotProjectionRow 结构性满足;Task 详情也能从
 * TaskRow 透传字段(snapshot.executions / executionEvidence,见 task-adapter)拼出,
 * 不需要完整投影行。
 */
export interface ExecutionEvidenceSourceRow {
  readonly taskId: string;
  readonly updatedAt: string;
  readonly snapshotAvailability?: TaskSnapshotProjectionRow["snapshotAvailability"];
  readonly snapshot: {
    readonly task?: { readonly title?: string };
    readonly executions: readonly Execution[];
    readonly reviews: readonly Review[];
    readonly consents: readonly Consent[];
    readonly gateWitnesses: readonly GateWitness[];
  };
  readonly executionEvidence: readonly ProjectedEvidence[];
}

/** 一个投影行的全部 execution 证据(输出/回执/见证按 execution 对齐)。 */
export function adaptTaskExecutions(row: ExecutionEvidenceSourceRow): ExecutionEvidenceRow[] {
  const taskTitle = row.snapshot.task?.title ?? row.taskId;
  return row.snapshot.executions.map((execution) => adaptExecution(row, execution, taskTitle));
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

function adaptExecution(
  row: ExecutionEvidenceSourceRow,
  execution: Execution,
  taskTitle: string,
): ExecutionEvidenceRow {
  const projections = row.executionEvidence.filter((item) => item.executionId === execution.executionId);
  const projection = projections.length === 1 ? projections[0] : undefined;
  const commitSha = text(execution.submission?.commitSha);
  const iteration = Number.isInteger(execution.iteration) ? execution.iteration : undefined;
  const reviews =
    commitSha === undefined || iteration === undefined
      ? []
      : row.snapshot.reviews.filter(
          (review) =>
            review.executionId === execution.executionId &&
            review.commitSha === commitSha &&
            review.iteration === iteration,
        );
  const reviewIds = new Set(reviews.map(({ reviewId }) => reviewId));
  const consents = row.snapshot.consents.filter(
    (consent) => consent.executionId === execution.executionId && reviewIds.has(consent.reviewId),
  );
  const selectedConsent = consents.at(-1);
  const gateWitnesses =
    commitSha === undefined || iteration === undefined
      ? []
      : row.snapshot.gateWitnesses.filter(
          (witness) =>
            witness.executionId === execution.executionId &&
            witness.commitSha === commitSha &&
            witness.iteration === iteration,
        );
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
    selectedReviewId: selectedConsent?.reviewId ?? null,
    selectedConsentId: selectedConsent?.consentId ?? null,
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

function adaptOutput(
  output: ProjectedOutput | undefined,
  submittedLocator: string | undefined,
): ExecutionEvidenceOutput {
  const candidate = output as Partial<ProjectedOutput> | undefined;
  const checkerReceiptRef = candidate?.checkerReceiptRef === null ? null : text(candidate?.checkerReceiptRef);
  const checkerResult =
    candidate?.checkerResult === "pass" || candidate?.checkerResult === "fail" || candidate?.checkerResult === "unknown"
      ? candidate.checkerResult
      : undefined;
  return {
    evidenceId: text(candidate?.evidenceId),
    locator: text(candidate?.locator),
    substrate:
      candidate?.substrate === "repository-path" ||
      candidate?.substrate === "uri" ||
      candidate?.substrate === "canonical-event" ||
      candidate?.substrate === "opaque"
        ? candidate.substrate
        : undefined,
    checkerReceiptRef,
    checkerResult,
    isPassingReceipt: checkerReceiptRef !== undefined && checkerReceiptRef !== null && checkerResult === "pass",
    raw: { submission: submittedLocator, projection: output ?? null },
  };
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

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { HarnessLayoutOverrides } from "../layout/index.ts";
import { defaultTaskProjectionPath, readTaskProjection } from "./sqlite-task-projection.ts";

interface ProjectionJsonObject { readonly [key: string]: ProjectionJsonValue }
type ProjectionJsonValue = string | number | boolean | null | ReadonlyArray<ProjectionJsonValue> | ProjectionJsonObject;

export interface SessionProjectionRow {
  readonly sessionId: string;
  readonly lifecycle: string;
  readonly archiveStatus: string;
  readonly runtime: string;
  readonly exportedAt: string | null;
  readonly bodySha256: string | null;
  readonly bodyRef: ProjectionJsonValue;
  readonly snapshot: ProjectionJsonValue;
}

export interface ExecutionProjectionRow {
  readonly executionId: string;
  readonly taskRef: string;
  readonly taskId: string;
  readonly state: string;
  readonly executor: ProjectionJsonValue;
  readonly primaryActor: ProjectionJsonValue;
  readonly claimedAt: string;
  readonly submittedAt: string | null;
  readonly closedAt: string | null;
  readonly sessionBindings: ReadonlyArray<ProjectionJsonObject>;
  readonly outputs: ReadonlyArray<ProjectionJsonValue>;
  readonly submission: ProjectionJsonValue;
}

export interface ReviewProjectionRow {
  readonly reviewId: string;
  readonly taskRef: string;
  readonly taskId: string;
  readonly executionRef: string;
  readonly executionId: string;
  readonly verdict: string;
  readonly reviewerActor: ProjectionJsonValue;
  readonly reviewerSessionRef: string;
  readonly findings: string;
  readonly evidenceChecked: ReadonlyArray<string>;
  readonly rationale: string;
  readonly archiveWarningsAcknowledged: boolean;
  readonly reviewedAt: string;
}

export interface ExecutionTraceRow extends ExecutionProjectionRow {
  readonly sessions: ReadonlyArray<SessionProjectionRow>;
  readonly reviews: ReadonlyArray<ReviewProjectionRow>;
}

export interface TaskExecutionTrace {
  readonly taskId: string;
  readonly executions: ReadonlyArray<ExecutionTraceRow>;
}

export type ProvenanceCoverage = "missing" | "partial" | "dangling";
export type ProvenanceFindingKind =
  | "task_execution_missing"
  | "execution_session_binding_missing"
  | "submitted_execution_review_missing"
  | "review_execution_missing"
  | "binding_session_missing"
  | "binding_archive_incomplete";

export interface ProvenanceAuditFinding {
  readonly coverage: ProvenanceCoverage;
  readonly kind: ProvenanceFindingKind;
  readonly taskId: string;
  readonly executionId?: string;
  readonly reviewId?: string;
  readonly sessionId?: string;
  readonly detail: string;
}

interface ProjectionReaderOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
}

export function querySessionProjection(options: ProjectionReaderOptions & { readonly sessionId: string }): SessionProjectionRow | undefined {
  const db = openFreshProjection(options);
  try {
    const row = db.prepare("SELECT * FROM session_projection WHERE session_id = ?").get(options.sessionId) as Record<string, unknown> | undefined;
    return row ? toSession(row) : undefined;
  } finally {
    db.close();
  }
}

export function queryExecutionProjection(options: ProjectionReaderOptions & { readonly executionId: string }): ExecutionProjectionRow | undefined {
  const db = openFreshProjection(options);
  try {
    const row = db.prepare("SELECT * FROM execution_projection WHERE execution_id = ?").get(options.executionId) as Record<string, unknown> | undefined;
    return row ? toExecution(row) : undefined;
  } finally {
    db.close();
  }
}

export function queryExecutionsByTask(options: ProjectionReaderOptions & { readonly taskId: string }): ReadonlyArray<ExecutionProjectionRow> {
  const db = openFreshProjection(options);
  try {
    return (db.prepare("SELECT * FROM execution_projection WHERE task_ref = ? ORDER BY claimed_at, execution_id")
      .all(`task/${options.taskId}`) as Record<string, unknown>[]).map(toExecution);
  } finally {
    db.close();
  }
}

export function queryReviewProjection(options: ProjectionReaderOptions & { readonly reviewId: string }): ReviewProjectionRow | undefined {
  const db = openFreshProjection(options);
  try {
    const row = db.prepare("SELECT * FROM review_projection WHERE review_id = ?").get(options.reviewId) as Record<string, unknown> | undefined;
    return row ? toReview(row) : undefined;
  } finally {
    db.close();
  }
}

export function queryTaskExecutionTrace(options: ProjectionReaderOptions & { readonly taskId: string }): TaskExecutionTrace {
  const db = openFreshProjection(options);
  try {
    const executions = (db.prepare("SELECT * FROM execution_projection WHERE task_ref = ? ORDER BY claimed_at, execution_id")
      .all(`task/${options.taskId}`) as Record<string, unknown>[]).map(toExecution);
    const sessions = new Map((db.prepare("SELECT * FROM session_projection ORDER BY session_id").all() as Record<string, unknown>[])
      .map((row) => toSession(row)).map((row) => [row.sessionId, row]));
    const reviews = (db.prepare("SELECT * FROM review_projection WHERE task_ref = ? ORDER BY reviewed_at, review_id")
      .all(`task/${options.taskId}`) as Record<string, unknown>[]).map(toReview);
    return {
      taskId: options.taskId,
      executions: executions.map((execution) => ({
        ...execution,
        sessions: execution.sessionBindings.flatMap((binding) => {
          const sessionId = entityId(binding.session_ref, "session/");
          const session = sessionId ? sessions.get(sessionId) : undefined;
          return session ? [session] : [];
        }),
        reviews: reviews.filter((review) => review.executionId === execution.executionId)
      }))
    };
  } finally {
    db.close();
  }
}

export function auditTaskProvenance(options: ProjectionReaderOptions & { readonly taskId: string }): {
  readonly taskId: string;
  readonly coverage: "complete" | "incomplete";
  readonly findings: ReadonlyArray<ProvenanceAuditFinding>;
} {
  const db = openFreshProjection(options);
  try {
    const executions = (db.prepare("SELECT * FROM execution_projection WHERE task_ref = ? ORDER BY execution_id")
      .all(`task/${options.taskId}`) as Record<string, unknown>[]).map(toExecution);
    const reviews = (db.prepare("SELECT * FROM review_projection WHERE task_ref = ? ORDER BY review_id")
      .all(`task/${options.taskId}`) as Record<string, unknown>[]).map(toReview);
    const sessionIds = new Set((db.prepare("SELECT session_id FROM session_projection").all() as Array<{ readonly session_id: string }>)
      .map((row) => row.session_id));
    const executionIds = new Set(executions.map((execution) => execution.executionId));
    const findings: ProvenanceAuditFinding[] = [];
    if (executions.length === 0) findings.push({
      coverage: "missing",
      kind: "task_execution_missing",
      taskId: options.taskId,
      detail: `Task ${options.taskId} has no Execution provenance.`
    });
    for (const review of reviews) {
      if (!executionIds.has(review.executionId)) findings.push({
        coverage: "dangling",
        kind: "review_execution_missing",
        taskId: options.taskId,
        reviewId: review.reviewId,
        executionId: review.executionId,
        detail: `Review ${review.reviewId} references missing execution ${review.executionId}.`
      });
    }
    for (const execution of executions) {
      const bound = execution.sessionBindings.filter((binding) => typeof binding.session_ref === "string");
      if (bound.length === 0) findings.push({
        coverage: "missing",
        kind: "execution_session_binding_missing",
        taskId: options.taskId,
        executionId: execution.executionId,
        detail: `Execution ${execution.executionId} has no session binding.`
      });
      for (const binding of bound) {
        const sessionId = entityId(binding.session_ref, "session/");
        if (sessionId && !sessionIds.has(sessionId)) findings.push({
          coverage: "dangling",
          kind: "binding_session_missing",
          taskId: options.taskId,
          executionId: execution.executionId,
          sessionId,
          detail: `Execution ${execution.executionId} binds missing session ${sessionId}.`
        });
        if (binding.archive_status !== "complete") findings.push({
          coverage: "partial",
          kind: "binding_archive_incomplete",
          taskId: options.taskId,
          executionId: execution.executionId,
          ...(sessionId ? { sessionId } : {}),
          detail: `Execution ${execution.executionId} has ${String(binding.archive_status ?? "unknown")} session archive coverage.`
        });
      }
      if (execution.state === "submitted" && !reviews.some((review) => review.executionId === execution.executionId)) findings.push({
        coverage: "partial",
        kind: "submitted_execution_review_missing",
        taskId: options.taskId,
        executionId: execution.executionId,
        detail: `Submitted execution ${execution.executionId} has no review.`
      });
    }
    findings.sort((left, right) => left.coverage.localeCompare(right.coverage) || left.kind.localeCompare(right.kind));
    return { taskId: options.taskId, coverage: findings.length === 0 ? "complete" : "incomplete", findings };
  } finally {
    db.close();
  }
}

export function querySessionExecutionTrace(options: ProjectionReaderOptions & { readonly sessionId: string }): {
  readonly sessionId: string;
  readonly session?: SessionProjectionRow;
  readonly executions: ReadonlyArray<ExecutionTraceRow>;
} {
  const db = openFreshProjection(options);
  try {
    const sessionRow = db.prepare("SELECT * FROM session_projection WHERE session_id = ?").get(options.sessionId) as Record<string, unknown> | undefined;
    const executions = (db.prepare("SELECT * FROM execution_projection ORDER BY claimed_at, execution_id").all() as Record<string, unknown>[])
      .map(toExecution)
      .filter((execution) => execution.sessionBindings.some((binding) => entityId(binding.session_ref, "session/") === options.sessionId));
    const reviews = (db.prepare("SELECT * FROM review_projection ORDER BY reviewed_at, review_id").all() as Record<string, unknown>[]).map(toReview);
    const session = sessionRow ? toSession(sessionRow) : undefined;
    return {
      sessionId: options.sessionId,
      ...(session ? { session } : {}),
      executions: executions.map((execution) => ({
        ...execution,
        sessions: session ? [session] : [],
        reviews: reviews.filter((review) => review.executionId === execution.executionId)
      }))
    };
  } finally {
    db.close();
  }
}

function openFreshProjection(options: ProjectionReaderOptions): DatabaseSync {
  const rootDir = path.resolve(options.rootDir);
  readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides });
  return new DatabaseSync(defaultTaskProjectionPath(rootDir), { readOnly: true });
}

function toSession(row: Record<string, unknown>): SessionProjectionRow {
  return {
    sessionId: String(row.session_id),
    lifecycle: String(row.lifecycle),
    archiveStatus: String(row.archive_status),
    runtime: String(row.runtime),
    exportedAt: nullableString(row.exported_at),
    bodySha256: nullableString(row.body_sha256),
    bodyRef: parseJson(row.body_ref_json),
    snapshot: parseJson(row.snapshot_json)
  };
}

function toExecution(row: Record<string, unknown>): ExecutionProjectionRow {
  const taskRef = String(row.task_ref);
  return {
    executionId: String(row.execution_id),
    taskRef,
    taskId: entityId(taskRef, "task/") ?? taskRef,
    state: String(row.state),
    executor: parseJson(row.executor),
    primaryActor: parseJson(row.primary_actor_json),
    claimedAt: String(row.claimed_at),
    submittedAt: nullableString(row.submitted_at),
    closedAt: nullableString(row.closed_at),
    sessionBindings: jsonArray(row.session_bindings_json).filter(isProjectionRecord),
    outputs: jsonArray(row.outputs_json),
    submission: parseJson(row.submission_json)
  };
}

function toReview(row: Record<string, unknown>): ReviewProjectionRow {
  const taskRef = String(row.task_ref);
  const executionRef = String(row.execution_ref);
  return {
    reviewId: String(row.review_id),
    taskRef,
    taskId: entityId(taskRef, "task/") ?? taskRef,
    executionRef,
    executionId: executionRef.split("/").at(-1) ?? executionRef,
    verdict: String(row.verdict),
    reviewerActor: parseJson(row.reviewer_actor),
    reviewerSessionRef: String(row.reviewer_session_ref),
    findings: String(row.findings),
    evidenceChecked: jsonArray(row.evidence_checked_json).filter((value): value is string => typeof value === "string"),
    rationale: String(row.rationale),
    archiveWarningsAcknowledged: row.archive_warnings_acknowledged === 1,
    reviewedAt: String(row.reviewed_at)
  };
}

function parseJson(value: unknown): ProjectionJsonValue {
  return typeof value === "string" ? JSON.parse(value) as ProjectionJsonValue : null;
}

function jsonArray(value: unknown): ReadonlyArray<ProjectionJsonValue> {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function entityId(value: unknown, prefix: string): string | undefined {
  return typeof value === "string" && value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function isProjectionRecord(value: ProjectionJsonValue): value is ProjectionJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

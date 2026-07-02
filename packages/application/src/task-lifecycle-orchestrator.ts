import { existsSync, readFileSync } from "node:fs";
import { Effect } from "effect";
import type { DomainStatus, EngineError, WriteError } from "../../kernel/src/index.ts";
import { isDomainStatus, isTerminalStatus, readTaskProjection } from "../../kernel/src/index.ts";
import type { HarnessLayoutInput, HarnessLayoutOverrides } from "../../kernel/src/layout/index.ts";
import { createHarnessRuntimeContext, readFrontmatter, readScalar, taskDocumentPath } from "../../kernel/src/layout/index.ts";
import { evaluateCompletionGate, evaluateReviewGate, isCloseoutPlaceholderMarkdown, isReviewPlaceholderMarkdown, parseReviewMarkdown } from "./task-lifecycle-gates.ts";
import type { TaskDocumentPlaceholderPolicy, VerifierBackedReviewContract } from "./task-lifecycle-gates.ts";

type CompletionGateResult = ReturnType<typeof evaluateCompletionGate>;

export interface TaskLifecycleStatusWriteResult {
  readonly taskId: string;
  readonly status: DomainStatus;
}

export interface TaskLifecycleProgressWriteResult {
  readonly taskId: string;
  readonly path: string;
}

export interface TaskLifecycleWriter {
  readonly setStatus: (payload: { readonly taskId: string; readonly status: DomainStatus }) => Effect.Effect<TaskLifecycleStatusWriteResult, EngineError | WriteError>;
  readonly appendProgress: (payload: { readonly taskId: string; readonly text: string }) => Effect.Effect<TaskLifecycleProgressWriteResult, EngineError | WriteError>;
}

export interface TaskLifecycleOrchestratorOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly taskWriter: TaskLifecycleWriter;
  readonly documentPlaceholderPolicy?: TaskDocumentPlaceholderPolicy;
  readonly now?: () => string;
}

export interface TaskLifecycleError {
  readonly code: string;
  readonly hint: string;
}

export interface TaskLifecycleFailure {
  readonly ok: false;
  readonly taskId: string;
  readonly error: TaskLifecycleError;
  readonly report?: unknown;
  readonly issues?: ReadonlyArray<unknown>;
  readonly completionGate?: CompletionGateResult;
}

export interface TaskLifecycleSuccess {
  readonly ok: true;
  readonly taskId: string;
  readonly status?: DomainStatus;
  readonly path?: string;
  readonly report?: unknown;
  readonly reviewContract?: VerifierBackedReviewContract;
  readonly completionGate?: CompletionGateResult;
}

export type TaskLifecycleResult = TaskLifecycleSuccess | TaskLifecycleFailure;

export interface TaskLifecycleOrchestrator {
  readonly setTaskStatus: (payload: { readonly taskId: string; readonly status: DomainStatus }) => Effect.Effect<TaskLifecycleResult>;
  readonly startTaskReview: (payload: { readonly taskId: string }) => Effect.Effect<TaskLifecycleResult>;
  readonly reviewTask: (payload: { readonly taskId: string; readonly reviewerId: string }) => Effect.Effect<TaskLifecycleResult>;
  readonly completeTask: (payload: { readonly taskId: string; readonly reviewerId: string; readonly ciGate: "passed" | "failed" }) => Effect.Effect<TaskLifecycleResult>;
}

export interface TaskLifecyclePolicy {
  readonly engine: string;
  readonly status: DomainStatus | null;
}

export function makeTaskLifecycleOrchestrator(options: TaskLifecycleOrchestratorOptions): TaskLifecycleOrchestrator {
  const layoutInput = createHarnessRuntimeContext(options.rootDir, options.layoutOverrides);

  return {
    setTaskStatus: (payload) => {
      if (isTerminalStatus(payload.status)) {
        return Effect.succeed(terminalStatusFailure(payload.taskId, payload.status));
      }
      return options.taskWriter.setStatus(payload).pipe(
        Effect.match({
          onFailure: (error): TaskLifecycleResult => writeFailure(payload.taskId, error, "Status update failed."),
          onSuccess: (result): TaskLifecycleResult => ({ ok: true, taskId: result.taskId, status: result.status })
        })
      );
    },
    startTaskReview: (payload) => options.taskWriter.setStatus({ taskId: payload.taskId, status: "in_review" }).pipe(
      Effect.match({
        onFailure: (error): TaskLifecycleResult => writeFailure(payload.taskId, error, "Review transition failed."),
        onSuccess: (result): TaskLifecycleResult => ({ ok: true, taskId: result.taskId, status: result.status })
      })
    ),
    reviewTask: (payload) => Effect.sync(() => reviewTask(layoutInput, payload.taskId, payload.reviewerId, options.now)),
    completeTask: (payload) => Effect.gen(function* () {
      const review = yield* Effect.sync(() => reviewTask(layoutInput, payload.taskId, payload.reviewerId, options.now));
      if (!review.ok) {
        return {
          ok: false,
          taskId: payload.taskId,
          report: review.report,
          issues: review.issues,
          error: {
            code: "review_not_passed",
            hint: "Task completion requires a passed task-review gate."
          }
        } satisfies TaskLifecycleResult;
      }

      const projection = readTaskProjection({ rootDir: options.rootDir, layoutOverrides: options.layoutOverrides });
      const row = projection.rows.find((item) => item.taskId === payload.taskId);
      if (!row) return taskFailure(payload.taskId, "task_not_found", `task not found: ${payload.taskId}`);

      const documentPlaceholder = validateCompletionDocumentPlaceholders(layoutInput, payload.taskId, options.documentPlaceholderPolicy);
      if (documentPlaceholder) return documentPlaceholder;

      const completionGate = evaluateCompletionGate({
        taskId: payload.taskId,
        coordinationStatus: row.coordinationStatus,
        packageDisposition: row.packageDisposition,
        closeoutReadiness: row.closeoutReadiness,
        reviewGate: "passed",
        ciGate: payload.ciGate
      });
      if (!completionGate.ok) {
        return {
          ok: false,
          taskId: payload.taskId,
          completionGate,
          issues: completionGate.issues,
          error: {
            code: completionGateErrorCode(completionGate.issues),
            hint: "Task completion gate failed."
          }
        } satisfies TaskLifecycleResult;
      }

      const status = yield* options.taskWriter.setStatus({ taskId: payload.taskId, status: "done" }).pipe(
        Effect.match({
          onFailure: (error): TaskLifecycleResult => writeFailure(payload.taskId, error, "Completion status update failed."),
          onSuccess: (result): TaskLifecycleResult => ({ ok: true, taskId: result.taskId, status: result.status })
        })
      );
      if (!status.ok) return status;
      return {
        ok: true,
        taskId: payload.taskId,
        status: status.status,
        completionGate,
        reviewContract: review.reviewContract
      } satisfies TaskLifecycleResult;
    })
  };
}

function validateCompletionDocumentPlaceholders(
  rootInput: HarnessLayoutInput,
  taskId: string,
  policy: TaskDocumentPlaceholderPolicy | undefined
): TaskLifecycleFailure | null {
  const closeoutPath = taskDocumentPath(rootInput, taskId, "closeout.md");
  if (policy && existsSync(closeoutPath) && isCloseoutPlaceholderMarkdown(readFileSync(closeoutPath, "utf8"), policy.closeoutPlaceholderFingerprints)) {
    return taskFailure(taskId, "closeout_placeholder", "Replace closeout.md template placeholders before completing the task.");
  }

  const reviewPath = taskDocumentPath(rootInput, taskId, "review.md");
  if (existsSync(reviewPath) && isReviewPlaceholderMarkdown(readFileSync(reviewPath, "utf8"))) {
    return taskFailure(taskId, "review_placeholder", "Replace the initial review.md placeholder with an actual review result before completing the task.");
  }

  return null;
}

export function readTaskLifecyclePolicy(rootInput: HarnessLayoutInput, taskId: string): TaskLifecyclePolicy | null {
  const indexPath = taskDocumentPath(rootInput, taskId, "INDEX.md");
  if (!existsSync(indexPath)) return null;
  const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
  if (!frontmatter) return null;
  const status = readScalar(frontmatter, "  status");
  return { engine: readScalar(frontmatter, "  engine") || "", status: isDomainStatus(status) ? status : null };
}

function reviewTask(
  rootInput: HarnessLayoutInput,
  taskId: string,
  reviewerId: string,
  now: (() => string) | undefined
): TaskLifecycleResult {
  const reviewPath = taskDocumentPath(rootInput, taskId, "review.md");
  if (!existsSync(reviewPath)) {
    return taskFailure(taskId, "review_document_missing", "Task review requires review.md in the task package.");
  }

  const parsed = parseReviewMarkdown(readFileSync(reviewPath, "utf8"));
  if (parsed.issues.length > 0) {
    return {
      ok: false,
      taskId,
      issues: parsed.issues,
      error: {
        code: "review_schema_invalid",
        hint: "review.md material findings table failed validation."
      }
    };
  }

  const gate = evaluateReviewGate({
    taskId,
    reviewerId,
    submittedAt: now ? now() : new Date().toISOString(),
    findings: parsed.findings
  });
  if (!gate.ok) {
    return {
      ok: false,
      taskId,
      report: gate,
      issues: gate.issues,
      error: {
        code: "release_blocking_findings",
        hint: "Open release-blocking findings must be closed before review passes."
      }
    };
  }

  return { ok: true, taskId, report: gate, reviewContract: gate.contract };
}

function terminalStatusFailure(taskId: string, status: DomainStatus): TaskLifecycleFailure {
  return taskFailure(
    taskId,
    "terminal_status_requires_task_complete",
    status === "done"
      ? "Use task-complete after review, CI, and closeout gates pass."
      : "Terminal cancellation requires an audited recovery path."
  );
}

function taskFailure(taskId: string, code: string, hint: string): TaskLifecycleFailure {
  return { ok: false, taskId, error: { code, hint } };
}

function writeFailure(taskId: string, error: EngineError | WriteError, fallbackHint: string): TaskLifecycleFailure {
  return taskFailure(taskId, error._tag, fallbackHint);
}

function completionGateErrorCode(issues: ReadonlyArray<{ readonly code: string }>): string {
  return issues[0]?.code ?? "completion_gate_failed";
}

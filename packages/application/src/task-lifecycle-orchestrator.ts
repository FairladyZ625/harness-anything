import { Effect } from "effect";
import type { ArtifactStore, DomainStatus, EngineError, IndeterminateFlushControlOutcome, WriteControl, WriteError } from "@harness-anything/kernel";
import { isDomainStatus, isIndeterminateFlushControlOutcome, isTerminalStatus } from "@harness-anything/kernel";
import type { HarnessLayoutOverrides } from "@harness-anything/kernel";
import { readFrontmatter, readScalar } from "@harness-anything/kernel";
import { evaluateCompletionGate, evaluateTaskReturnToIdeaGate } from "./task-lifecycle-gates.ts";
import type { TaskDocumentPlaceholderPolicy, VerifierBackedReviewContract } from "./task-lifecycle-gates.ts";
import type { TaskCompletionEvidence, TaskCompletionEvidenceMode } from "./task-completion-authority.ts";
import {
  readTaskDocument,
  reviewTask,
  taskFailure,
  terminalStatusFailure
} from "./task-lifecycle-orchestrator-helpers.ts";
import { validateTaskPlanAdmissionPreflight } from "./task-plan-admission-preflight.ts";
import type { ReadTaskReturnToIdeaSnapshotV1 } from "./authority/task-return-to-idea-policy.ts";

type CompletionGateResult = ReturnType<typeof evaluateCompletionGate> & {
  readonly evidenceMode?: TaskCompletionEvidenceMode;
};

export interface TaskLifecycleStatusWriteResult {
  readonly taskId: string;
  readonly status: DomainStatus;
}

export interface TaskLifecycleProgressWriteResult {
  readonly taskId: string;
  readonly path: string;
}

export interface TaskLifecycleTreeStatusResult {
  readonly taskId: string;
  readonly dirty: boolean;
  readonly entries: ReadonlyArray<string>;
}

export interface TaskLifecycleWriter {
  readonly setStatus: (plan: TaskLifecycleStatusMutationPlan) => Effect.Effect<TaskLifecycleStatusWriteResult, EngineError | WriteControl>;
  readonly appendProgress: (payload: { readonly taskId: string; readonly text: string }) => Effect.Effect<TaskLifecycleProgressWriteResult, EngineError | WriteControl>;
  readonly stageDocument: (payload: { readonly taskId: string; readonly path: string }) => Effect.Effect<TaskLifecycleProgressWriteResult, EngineError | WriteControl>;
  readonly stageTaskTree: (payload: { readonly taskId: string }) => Effect.Effect<TaskLifecycleProgressWriteResult, EngineError | WriteControl>;
  readonly taskTreeStatus: (payload: { readonly taskId: string }) => Effect.Effect<TaskLifecycleTreeStatusResult, EngineError | WriteControl>;
}

export interface TaskLifecycleStatusMutationPlan {
  readonly schema: "task-lifecycle-status-mutation-plan/v1";
  readonly taskId: string;
  readonly status: "planned" | "active" | "blocked";
  readonly witness: {
    readonly kind: "task-lifecycle-orchestrator";
    readonly from: DomainStatus | null;
    readonly to: "planned" | "active" | "blocked";
  };
}

export interface TaskLifecycleOrchestratorOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly taskWriter: TaskLifecycleWriter;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage">;
  readonly documentPlaceholderPolicy?: TaskDocumentPlaceholderPolicy;
  readonly now?: () => string;
  readonly readTaskReturnToIdeaSnapshot?: ReadTaskReturnToIdeaSnapshotV1;
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
  readonly executionId?: string;
  readonly completionEvidence?: TaskCompletionEvidence;
  readonly warnings?: ReadonlyArray<TaskLifecycleWarning>;
}

export type TaskLifecycleResult = TaskLifecycleSuccess | TaskLifecycleFailure;

export interface TaskLifecycleWarning {
  readonly severity: "warning";
  readonly code: string;
  readonly message: string;
  readonly revivalCondition: string;
  readonly issues?: ReadonlyArray<{
    readonly code?: string;
    readonly findingId?: string;
    readonly message?: string;
  }>;
}

export interface TaskLifecycleOrchestrator {
  readonly setTaskStatus: (payload: { readonly taskId: string; readonly status: DomainStatus }) => Effect.Effect<TaskLifecycleResult, IndeterminateFlushControlOutcome>;
  readonly startTaskReview: (payload: { readonly taskId: string }) => Effect.Effect<TaskLifecycleResult>;
  readonly reviewTask: (payload: { readonly taskId: string; readonly reviewerId: string }) => Effect.Effect<TaskLifecycleResult, IndeterminateFlushControlOutcome>;
}

export interface TaskLifecyclePolicy {
  readonly engine: string;
  readonly status: DomainStatus | null;
}

export function makeTaskLifecycleOrchestrator(options: TaskLifecycleOrchestratorOptions): TaskLifecycleOrchestrator {
  return {
    setTaskStatus: (payload) => Effect.gen(function* () {
      if (!isDomainStatus(payload.status)) {
        return taskFailure(
          payload.taskId,
          "invalid_status",
          `Invalid lifecycle status: ${String(payload.status)}. Valid statuses: planned, active, blocked, in_review, done, cancelled.`
        );
      }
      if (isTerminalStatus(payload.status)) {
        return terminalStatusFailure(payload.taskId, payload.status);
      }
      if (payload.status === "in_review") {
        return taskFailure(
          payload.taskId,
          "invalid_transition",
          "Task review state is created only by an Execution submit-for-review transaction."
        );
      }
      const policy = yield* readTaskLifecyclePolicy(options.artifactStore, payload.taskId);
      if (policy?.status === "in_review") {
        return taskFailure(
          payload.taskId,
          "invalid_transition",
          "A Task in review can leave that state only through an execution-scoped Review transaction. Use changes_requested to return it to active."
        );
      }
      if (payload.status === "planned") {
        const inspection = yield* Effect.tryPromise({
          try: () => options.readTaskReturnToIdeaSnapshot
            ? options.readTaskReturnToIdeaSnapshot(payload.taskId)
            : Promise.reject(new Error("Return-to-idea snapshot reader is unavailable.")),
          catch: (error) => error
        }).pipe(Effect.match({
          onFailure: (error) => ({
            ok: false as const,
            hint: `Return-to-idea safety inspection failed closed: ${error instanceof Error ? error.message : String(error)}`
          }),
          onSuccess: (snapshot) => ({ ok: true as const, snapshot })
        }));
        if (!inspection.ok) {
          return taskFailure(payload.taskId, "task_return_to_idea_blocked", inspection.hint);
        }
        const gate = evaluateTaskReturnToIdeaGate(inspection.snapshot);
        if (!gate.ok) {
          return taskFailure(
            payload.taskId,
            "task_return_to_idea_blocked",
            `Task ${payload.taskId} cannot return to planned. ${gate.issues.map((issue) => issue.message).join(" ")}`
          );
        }
      }
      if (payload.status === "active" || payload.status === "blocked") {
        const planPlaceholder = yield* validateTaskPlanAdmissionPreflight({
          artifactStore: options.artifactStore,
          rootDir: options.rootDir,
          layoutOverrides: options.layoutOverrides,
          taskId: payload.taskId,
          policy: options.documentPlaceholderPolicy
        });
        if (planPlaceholder) {
          return taskFailure(payload.taskId, planPlaceholder.code, planPlaceholder.hint);
        }
      }
      const mutationPlan = planTaskLifecycleStatusMutation({
        taskId: payload.taskId,
        status: directTaskLifecycleStatus(payload.status)
      }, policy?.status ?? null);
      return yield* options.taskWriter.setStatus(mutationPlan).pipe(
        Effect.matchEffect({
          onFailure: (error) => isIndeterminateFlushControlOutcome(error)
            ? Effect.fail(error)
            : Effect.succeed(writeFailure(payload.taskId, error, "Status update failed.")),
          onSuccess: (result) => Effect.succeed<TaskLifecycleResult>({ ok: true, taskId: result.taskId, status: result.status })
        })
      );
    }),
    startTaskReview: (payload) => Effect.succeed(taskFailure(
      payload.taskId,
      "execution_submission_required",
      "Task review state is created only by an Execution submit-for-review transaction."
    )),
    reviewTask: (payload) => Effect.gen(function* () {
      const review = yield* reviewTask(options.artifactStore, payload.taskId, payload.reviewerId, options.now);
      if (!review.ok) return review;
      const staged = yield* stageTaskTree(options.taskWriter, payload.taskId, "Review artifact staging failed.");
      if (!staged.ok) return staged;
      return {
        ok: true,
        taskId: payload.taskId,
        path: staged.path,
        report: review.report,
        reviewContract: review.reviewContract,
        ...(review.warnings ? { warnings: review.warnings } : {})
      };
    })
  };
}

function planTaskLifecycleStatusMutation(
  payload: { readonly taskId: string; readonly status: "planned" | "active" | "blocked" },
  from: DomainStatus | null
): TaskLifecycleStatusMutationPlan {
  switch (payload.status) {
    case "planned":
    case "active":
    case "blocked":
      return {
        schema: "task-lifecycle-status-mutation-plan/v1",
        taskId: payload.taskId,
        status: payload.status,
        witness: { kind: "task-lifecycle-orchestrator", from, to: payload.status }
      };
    default:
      return taskLifecycleStatusNever(payload.status);
  }
}

function taskLifecycleStatusNever(value: never): never {
  throw new Error(`TASK_LIFECYCLE_STATUS_EXHAUSTIVENESS_BREACH:${String(value)}`);
}

function directTaskLifecycleStatus(value: DomainStatus): "planned" | "active" | "blocked" {
  switch (value) {
    case "planned":
    case "active":
    case "blocked":
      return value;
    case "in_review":
    case "done":
    case "cancelled":
      throw new Error(`TASK_LIFECYCLE_DIRECT_STATUS_FORBIDDEN:${value}`);
    default:
      return taskLifecycleStatusNever(value);
  }
}

function stageTaskTree(
  writer: TaskLifecycleWriter,
  taskId: string,
  failureHint: string
): Effect.Effect<TaskLifecycleResult, IndeterminateFlushControlOutcome> {
  return writer.stageTaskTree({ taskId }).pipe(
    Effect.matchEffect({
      onFailure: (error) => isIndeterminateFlushControlOutcome(error)
        ? Effect.fail(error)
        : Effect.succeed(writeFailure(taskId, error, failureHint)),
      onSuccess: (result) => Effect.succeed<TaskLifecycleResult>({ ok: true, taskId: result.taskId, path: result.path })
    })
  );
}

export function readTaskLifecyclePolicy(artifactStore: Pick<ArtifactStore, "readTaskPackage">, taskId: string): Effect.Effect<TaskLifecyclePolicy | null> {
  return Effect.gen(function* () {
    const body = yield* readTaskDocument(artifactStore, taskId, "INDEX.md");
    if (body === null) return null;
    const frontmatter = readFrontmatter(body);
    if (!frontmatter) return null;
    const status = readScalar(frontmatter, "  status");
    return { engine: readScalar(frontmatter, "  engine") || "", status: isDomainStatus(status) ? status : null };
  });
}

function writeFailure(taskId: string, error: EngineError | WriteError, fallbackHint: string): TaskLifecycleFailure {
  return taskFailure(taskId, writeFailureCode(error), `${fallbackHint} ${writeFailureCauseHint(error)}`);
}

// Canonical kernel-tag -> CLI error-code mapping. Kept exhaustive by the mapped
// type: adding or removing an EngineError/WriteError tag breaks compilation until
// this table is updated, so a writer failure can never leak an unregistered code
// that the CLI would coerce into a misleading generic write rejection. Values must
// stay in lockstep with the CLI error-code registry (packages/cli/src/cli/error-codes.ts);
// the application layer cannot import that registry across the package boundary.
const writeFailureCodeByTag: Readonly<Record<(EngineError | WriteError)["_tag"], string>> = {
  EngineNotEnabled: "EngineNotEnabled",
  AdapterUnavailable: "AdapterUnavailable",
  AuthMissing: "AuthMissing",
  RefNotFound: "RefNotFound",
  TaskAlreadyExists: "task_already_exists",
  TaskNotFound: "task_not_found",
  InvalidTransition: "invalid_transition",
  DuplicateExternalBinding: "duplicate_external_binding",
  DuplicateAdoptClaim: "duplicate_adopt_claim",
  StaleSnapshotRefused: "stale_snapshot_refused",
  GeneratedTaskIdRequired: "generated_task_id_required",
  MalformedSnapshot: "malformed_snapshot",
  StatusUnmapped: "StatusUnmapped",
  EngineOwnsStatus: "engine_owns_status",
  TerminalReopenRequiresSupersede: "terminal_reopen_requires_supersede",
  ArchivedHardDeleteForbidden: "archived_hard_delete_forbidden",
  TerminalHardDeleteForbidden: "terminal_hard_delete_forbidden",
  RelatedTaskHardDeleteForbidden: "related_task_hard_delete_forbidden",
  RateLimited: "RateLimited",
  EngineUnreachable: "EngineUnreachable",
  Timeout: "Timeout",
  WriteRejected: "write_rejected",
  WriteConflict: "write_conflict",
  GlobalWriteConflict: "write_conflict",
  JournalUnavailable: "journal_unavailable"
};

function writeFailureCode(error: EngineError | WriteError): string {
  return writeFailureCodeByTag[error._tag];
}

function writeFailureCauseHint(error: EngineError | WriteError): string {
  switch (error._tag) {
    case "MalformedSnapshot":
      return `Cause: ${String(error.raw)}`;
    case "TaskNotFound":
      return `Cause: task not found: ${error.taskId}`;
    case "InvalidTransition":
      return `Cause: invalid transition: ${error.from} -> ${error.to}`;
    case "EngineOwnsStatus":
      return `Cause: status is owned by ${error.engine}.`;
    case "WriteRejected":
      return `Cause: ${error.reason}`;
    case "WriteConflict":
      return `Cause: ${error.owner ?? "write lock is held"}`;
    case "GlobalWriteConflict":
      return `Cause: ${error.owner ? `global write lock is held: ${error.owner}` : "global write lock is held"}`;
    case "JournalUnavailable":
      return `Cause: ${journalCause(error.cause)}`;
    default:
      return `Cause: ${error._tag}`;
  }
}

function journalCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message.trim().split(/\r?\n/u)[0] ?? "journal unavailable";
  if (typeof cause === "string" && cause.trim().length > 0) return cause.trim().split(/\r?\n/u)[0] ?? "journal unavailable";
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string" && cause.message.trim().length > 0) {
    return cause.message.trim().split(/\r?\n/u)[0] ?? "journal unavailable";
  }
  return "journal unavailable";
}

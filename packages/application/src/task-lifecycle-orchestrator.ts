import { Effect } from "effect";
import type { ArtifactStore, DomainStatus, EngineError, TaskHolderPrincipal, TaskId, VersionControlSystem, WriteError } from "@harness-anything/kernel";
import { isDomainStatus, isTerminalStatus, readTaskProjection, resolveHarnessLayout, sha256Text } from "@harness-anything/kernel";
import type { HarnessLayoutOverrides } from "@harness-anything/kernel";
import { readFrontmatter, readScalar } from "@harness-anything/kernel";
import { evaluateCodeDocReconciliationGate } from "./code-doc-reconciliation.ts";
import { parseTaskContractSnapshot, resolveTaskCompletionGates } from "./task-contract-snapshot.ts";
import { validateTaskActivationReadiness } from "./task-activation-readiness.ts";
import { evaluateCompletionGate } from "./task-lifecycle-gates.ts";
import type { CompletionCiGateStatus, TaskDocumentPlaceholderPolicy, VerifierBackedReviewContract } from "./task-lifecycle-gates.ts";
import type { ExecutionCompletionService } from "./execution-completion-service.ts";
import { evaluateTaskCompletionAuthority, type CommitCompletionService, type TaskCompletionEvidence, type TaskCompletionEvidenceMode } from "./task-completion-authority.ts";
import { completeTaskWithCommitEvidence } from "./commit-completion-orchestrator.ts";
import {
  legacyReviewCompatibility,
  readTaskDocument,
  reviewTask,
  taskFailure,
  terminalStatusDemotionWarning
} from "./task-lifecycle-orchestrator-helpers.ts";
import { collectCompletionRequirementIssues, completionRequirementsFailure, isExecutionCompletionRequirement, validateCompletionDocumentPlaceholders } from "./task-completion-requirements.ts";

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
  readonly setStatus: (payload: { readonly taskId: string; readonly status: DomainStatus }) => Effect.Effect<TaskLifecycleStatusWriteResult, EngineError | WriteError>;
  readonly appendProgress: (payload: { readonly taskId: string; readonly text: string }) => Effect.Effect<TaskLifecycleProgressWriteResult, EngineError | WriteError>;
  readonly stageDocument: (payload: { readonly taskId: string; readonly path: string }) => Effect.Effect<TaskLifecycleProgressWriteResult, EngineError | WriteError>;
  readonly stageTaskTree: (payload: { readonly taskId: string }) => Effect.Effect<TaskLifecycleProgressWriteResult, EngineError | WriteError>;
  readonly taskTreeStatus: (payload: { readonly taskId: string }) => Effect.Effect<TaskLifecycleTreeStatusResult, EngineError | WriteError>;
}

export interface TaskLifecycleOrchestratorOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly taskWriter: TaskLifecycleWriter;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage">;
  readonly documentPlaceholderPolicy?: TaskDocumentPlaceholderPolicy;
  readonly codeDocVersionControlSystem?: Pick<VersionControlSystem, "normalizePath" | "topLevel" | "commitExists" | "pathExistsAtCommit" | "resolveCommit">;
  readonly now?: () => string;
  readonly executionCompletionService?: ExecutionCompletionService;
  readonly commitCompletionService?: CommitCompletionService;
  readonly completionGateResolver?: (input: {
    readonly vertical?: string;
    readonly preset?: string;
    readonly profile?: string;
  }) => ReadonlyArray<string>;
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
  readonly setTaskStatus: (payload: { readonly taskId: string; readonly status: DomainStatus }) => Effect.Effect<TaskLifecycleResult>;
  readonly startTaskReview: (payload: { readonly taskId: string }) => Effect.Effect<TaskLifecycleResult>;
  readonly reviewTask: (payload: { readonly taskId: string; readonly reviewerId: string }) => Effect.Effect<TaskLifecycleResult>;
  readonly completeTask: (payload: {
    readonly taskId: string;
    readonly reviewerId: string;
    readonly ciGate?: CompletionCiGateStatus;
    readonly actor?: TaskHolderPrincipal;
    readonly evidenceMode?: TaskCompletionEvidenceMode;
    readonly commitRef?: string;
    readonly judgment?: string;
    readonly sessionRef?: string;
  }) => Effect.Effect<TaskLifecycleResult>;
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
        return yield* options.taskWriter.setStatus(payload).pipe(
          Effect.match({
            onFailure: (error): TaskLifecycleResult => writeFailure(payload.taskId, error, "Status update failed."),
            onSuccess: (result): TaskLifecycleResult => ({
              ok: true,
              taskId: result.taskId,
              status: result.status,
              warnings: [terminalStatusDemotionWarning(payload.taskId)]
            })
          })
        );
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
      if (payload.status === "active" && options.documentPlaceholderPolicy) {
        const readiness = yield* validateTaskActivationReadiness({
          artifactStore: options.artifactStore,
          rootDir: options.rootDir,
          layoutOverrides: options.layoutOverrides,
          taskId: payload.taskId,
          policy: options.documentPlaceholderPolicy
        });
        if (!readiness.ok) return readiness;
      }
      return yield* options.taskWriter.setStatus(payload).pipe(
        Effect.match({
          onFailure: (error): TaskLifecycleResult => writeFailure(payload.taskId, error, "Status update failed."),
          onSuccess: (result): TaskLifecycleResult => ({ ok: true, taskId: result.taskId, status: result.status })
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
    }),
    completeTask: (payload) => Effect.gen(function* () {
      const evidenceMode = payload.evidenceMode ?? "execution-review";
      if (!payload.actor
        || (evidenceMode === "execution-review" && !options.executionCompletionService)
        || (evidenceMode === "commit-anchor" && !options.commitCompletionService)) {
        return taskFailure(
          payload.taskId,
          "write_rejected",
          "Task completion requires the Execution completion service and an authorized actor."
        );
      }
      const legacyReview = yield* legacyReviewCompatibility(
        options.artifactStore,
        payload.taskId,
        payload.reviewerId,
        options.now
      );
      if (legacyReview.blocker) return legacyReview.blocker;
      const legacyReviewWarnings = legacyReview.warnings;

      const projection = readTaskProjection({ rootDir: options.rootDir, layoutOverrides: options.layoutOverrides });
      const row = projection.rows.find((item) => item.taskId === payload.taskId);
      if (!row) return taskFailure(payload.taskId, "task_not_found", `task not found: ${payload.taskId}`);
      const taskPackage = yield* options.artifactStore.readTaskPackage(payload.taskId as TaskId).pipe(
        Effect.catchAll(() => Effect.succeed(null))
      );
      if (!taskPackage) return taskFailure(payload.taskId, "task_not_found", `task package not found: ${payload.taskId}`);
      const contractBody = taskPackage.documents.find((document) => document.path === "task-contract.json")?.body ?? null;
      let contractSnapshot;
      try {
        contractSnapshot = contractBody === null ? undefined : parseTaskContractSnapshot(contractBody);
      } catch (error) {
        return taskFailure(
          payload.taskId,
          "completion_contract_invalid",
          `Task contract snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      const completionGates = resolveTaskCompletionGates({
        ...(contractSnapshot ? { snapshot: contractSnapshot } : {}),
        vertical: row.vertical,
        preset: row.preset,
        profile: row.profile,
        legacyResolver: options.completionGateResolver
      });
      if (!completionGates.ok) return taskFailure(payload.taskId, "completion_contract_invalid", completionGates.message);

      const documentPlaceholder = yield* validateCompletionDocumentPlaceholders(
        options.artifactStore,
        payload.taskId,
        options.documentPlaceholderPolicy
      );
      let codeDocReconciliation: TaskLifecycleFailure | null = null;
      if (completionGates.gates.includes("code-doc-reconciliation")) {
        codeDocReconciliation = yield* validateCodeDocReconciliation(
          options.artifactStore,
          options.rootDir,
          resolveHarnessLayout({ rootDir: options.rootDir, layoutOverrides: options.layoutOverrides }).authoredRoot,
          payload.taskId,
          options.codeDocVersionControlSystem
        );
      }

      const closeoutBody = taskPackage.documents.find((document) => document.path === "closeout.md")?.body;
      const closeoutReadiness = evidenceMode === "commit-anchor"
        ? closeoutBody && !documentPlaceholder ? "ready" : "missing"
        : row.closeoutReadiness;
      const completionGate = evaluateCompletionGate({
        taskId: payload.taskId,
        coordinationStatus: row.coordinationStatus,
        packageDisposition: row.packageDisposition,
        closeoutReadiness,
        reviewGate: "passed",
        ciGate: payload.ciGate,
        applicableGates: completionGates.gates
      });
      let completionAuthority;
      try {
        completionAuthority = evaluateTaskCompletionAuthority({
          taskId: payload.taskId,
          mode: evidenceMode,
          status: row.coordinationStatus,
          documents: taskPackage.documents,
          actor: payload.actor,
          sessionRef: payload.sessionRef ?? "session/unavailable",
          judgedAt: options.now ? options.now() : new Date().toISOString(),
          applicableGates: completionGates.gates,
          ciGate: payload.ciGate,
          commitRef: payload.commitRef,
          judgment: payload.judgment,
          rootDir: options.rootDir,
          versionControlSystem: options.codeDocVersionControlSystem
        });
      } catch (error) {
        return taskFailure(payload.taskId, "write_rejected", error instanceof Error ? error.message : String(error));
      }
      const requirementIssues = collectCompletionRequirementIssues({
        taskId: payload.taskId,
        documentPlaceholder,
        codeDocReconciliation,
        completionGate,
        completionAuthority: completionAuthority.ok
          ? { executionId: completionAuthority.evidenceMode === "execution-review" ? completionAuthority.executionId : undefined, issues: [] }
          : { issues: completionAuthority.issues }
      });
      if (requirementIssues.length > 0) {
        if (requirementIssues.every((issue) => isExecutionCompletionRequirement(issue.code))) {
          const taskTreeFailure = yield* prepareCompletionTaskTree(options.taskWriter, payload.taskId, completionGate);
          if (taskTreeFailure) return taskTreeFailure;
        }
        return completionRequirementsFailure(payload.taskId, requirementIssues, completionGate);
      }

      const taskTreeFailure = yield* prepareCompletionTaskTree(options.taskWriter, payload.taskId, completionGate);
      if (taskTreeFailure) return taskTreeFailure;
      if (evidenceMode === "commit-anchor") {
        const result = yield* completeTaskWithCommitEvidence(options.commitCompletionService!, {
          taskId: payload.taskId,
          mode: "commit-anchor",
          status: row.coordinationStatus,
          documents: taskPackage.documents,
          actor: payload.actor!,
          sessionRef: payload.sessionRef ?? "session/unavailable",
          judgedAt: options.now ? options.now() : new Date().toISOString(),
          applicableGates: completionGates.gates,
          ciGate: payload.ciGate,
          commitRef: payload.commitRef,
          judgment: payload.judgment,
          rootDir: options.rootDir
        }, completionGate);
        return result.ok && legacyReviewWarnings.length > 0
          ? { ...result, warnings: legacyReviewWarnings }
          : result;
      }

      const completion = yield* Effect.tryPromise({
        try: () => options.executionCompletionService!.completeTaskExecution({
          taskId: payload.taskId,
          actor: payload.actor!,
          contractPrecondition: { bodySha256: contractBody === null ? null : sha256Text(contractBody) }
        }),
        catch: (error) => error
      }).pipe(Effect.match({
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: (result) => ({ ok: true as const, result })
      }));
      if (!completion.ok) {
        return taskFailure(payload.taskId, "write_rejected", completion.error instanceof Error ? completion.error.message : String(completion.error));
      }
      if (!completion.result) {
        return taskFailure(
          payload.taskId,
          "write_rejected",
          "Task completion requires a submitted Execution with a matching approved Review."
        );
      }
      return {
        ok: true,
        taskId: payload.taskId,
        executionId: completion.result.executionId,
        status: "done",
        completionGate: { ...completionGate, evidenceMode: "execution-review" },
        ...(legacyReviewWarnings.length > 0 ? { warnings: legacyReviewWarnings } : {})
      } satisfies TaskLifecycleResult;
    })
  };
}

function prepareCompletionTaskTree(
  writer: TaskLifecycleWriter,
  taskId: string,
  completionGate: CompletionGateResult
): Effect.Effect<TaskLifecycleFailure | null> {
  return Effect.gen(function* () {
    const staged = yield* stageTaskTree(writer, taskId, "Completion task-tree staging failed.");
    if (!staged.ok) return staged;
    return yield* writer.taskTreeStatus({ taskId }).pipe(
      Effect.match({
        onFailure: (error): TaskLifecycleFailure => writeFailure(taskId, error, "Completion task-tree dirty check failed."),
        onSuccess: (result): TaskLifecycleFailure | null => result.dirty
          ? taskTreeDirtyFailure(taskId, result.entries, completionGate)
          : null
      })
    );
  });
}

function stageTaskTree(
  writer: TaskLifecycleWriter,
  taskId: string,
  failureHint: string
): Effect.Effect<TaskLifecycleResult> {
  return writer.stageTaskTree({ taskId }).pipe(
    Effect.match({
      onFailure: (error): TaskLifecycleResult => writeFailure(taskId, error, failureHint),
      onSuccess: (result): TaskLifecycleResult => ({ ok: true, taskId: result.taskId, path: result.path })
    })
  );
}

function validateCodeDocReconciliation(
  artifactStore: Pick<ArtifactStore, "readTaskPackage">,
  rootDir: string,
  authoredRoot: string,
  taskId: string,
  versionControlSystem: Pick<VersionControlSystem, "normalizePath" | "topLevel" | "commitExists" | "pathExistsAtCommit"> | undefined
): Effect.Effect<TaskLifecycleFailure | null> {
  return Effect.gen(function* () {
    const taskPackage = yield* artifactStore.readTaskPackage(taskId as TaskId).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    );
    if (taskPackage === null) {
      return taskFailure(taskId, "code_doc_reconciliation_failed", "Task completion requires a readable task package for code-doc reconciliation.");
    }
    const gate = evaluateCodeDocReconciliationGate({
      taskId,
      rootDir,
      authoredRoot,
      documents: taskPackage.documents,
      versionControlSystem
    });
    if (gate.ok) return null;
    return {
      ok: false,
      taskId,
      report: gate,
      issues: gate.issues,
      error: {
        code: "code_doc_reconciliation_failed",
        hint: "Task completion requires load-bearing code-doc records to anchor to git commits or path@commit evidence."
      }
    };
  });
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

function taskTreeDirtyFailure(
  taskId: string,
  entries: ReadonlyArray<string>,
  completionGate: CompletionGateResult
): TaskLifecycleFailure {
  const issue = {
    code: "task_tree_dirty" as const,
    message: `Task package has uncommitted changes after sweep: ${entries.slice(0, 5).join(", ")}${entries.length > 5 ? ", ..." : ""}`
  };
  return {
    ok: false,
    taskId,
    completionGate: {
      ...completionGate,
      ok: false,
      issues: [...completionGate.issues, issue]
    },
    issues: [issue],
    error: {
      code: issue.code,
      hint: "Task completion requires tasks/<id>/ to be clean after the transition sweep. Let the lifecycle transition commit the task package, then rerun task complete."
    }
  };
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

import { Effect } from "effect";
import type { ArtifactStore, DomainStatus, EngineError, TaskHolderPrincipal, TaskId, VersionControlSystem, WriteError } from "../../kernel/src/index.ts";
import { isDomainStatus, isTerminalStatus, readTaskProjection, resolveHarnessLayout } from "../../kernel/src/index.ts";
import type { HarnessLayoutOverrides } from "../../kernel/src/index.ts";
import { readFrontmatter, readScalar } from "../../kernel/src/index.ts";
import { evaluateCodeDocReconciliationGate } from "./code-doc-reconciliation.ts";
import { parseTaskContractSnapshot, resolveTaskCompletionGates } from "./task-contract-snapshot.ts";
import { evaluateCompletionGate, evaluateReviewGate, isReviewPlaceholderMarkdown, isTaskDocumentPlaceholderMarkdown, parseReviewMarkdown } from "./task-lifecycle-gates.ts";
import type { TaskDocumentPlaceholderPolicy, VerifierBackedReviewContract } from "./task-lifecycle-gates.ts";
import type { ExecutionCompletionReadiness, ExecutionCompletionService } from "./execution-completion-service.ts";
import { collectCompletionRequirementIssues, completionRequirementsFailure, isExecutionCompletionRequirement, validateCompletionDocumentPlaceholders } from "./task-completion-requirements.ts";

type CompletionGateResult = ReturnType<typeof evaluateCompletionGate>;

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
  readonly codeDocVersionControlSystem?: Pick<VersionControlSystem, "normalizePath" | "topLevel" | "commitExists" | "pathExistsAtCommit">;
  readonly now?: () => string;
  readonly executionCompletionService?: ExecutionCompletionService;
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
}

export type TaskLifecycleResult = TaskLifecycleSuccess | TaskLifecycleFailure;

export interface TaskLifecycleOrchestrator {
  readonly setTaskStatus: (payload: { readonly taskId: string; readonly status: DomainStatus }) => Effect.Effect<TaskLifecycleResult>;
  readonly startTaskReview: (payload: { readonly taskId: string }) => Effect.Effect<TaskLifecycleResult>;
  readonly reviewTask: (payload: { readonly taskId: string; readonly reviewerId: string }) => Effect.Effect<TaskLifecycleResult>;
  readonly completeTask: (payload: { readonly taskId: string; readonly reviewerId: string; readonly ciGate?: "passed" | "failed"; readonly actor?: TaskHolderPrincipal }) => Effect.Effect<TaskLifecycleResult>;
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
          "execution_submission_required",
          "Task review state is created only by an Execution submit-for-review transaction."
        );
      }
      const policy = yield* readTaskLifecyclePolicy(options.artifactStore, payload.taskId);
      if (policy?.status === "in_review") {
        return taskFailure(
          payload.taskId,
          "execution_review_required",
          "A Task in review can leave that state only through an execution-scoped Review transaction. Use changes_requested to return it to active."
        );
      }
      if (payload.status === "active") {
        const planPlaceholder = yield* validateActiveTaskPlanPlaceholder(
          options.artifactStore,
          options.rootDir,
          options.layoutOverrides,
          payload.taskId,
          options.documentPlaceholderPolicy
        );
        if (planPlaceholder) return planPlaceholder;
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
      return { ok: true, taskId: payload.taskId, path: staged.path, report: review.report, reviewContract: review.reviewContract };
    }),
    completeTask: (payload) => Effect.gen(function* () {
      if (!options.executionCompletionService || !payload.actor) {
        return taskFailure(
          payload.taskId,
          "execution_completion_required",
          "Task completion requires the Execution completion service and an authorized actor."
        );
      }
      const legacyReviewBlocker = yield* validateLegacyReviewCompatibilityBlockers(
        options.artifactStore,
        payload.taskId,
        payload.reviewerId,
        options.now
      );

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

      const completionGate = evaluateCompletionGate({
        taskId: payload.taskId,
        coordinationStatus: row.coordinationStatus,
        packageDisposition: row.packageDisposition,
        closeoutReadiness: row.closeoutReadiness,
        reviewGate: "passed",
        ciGate: payload.ciGate,
        applicableGates: completionGates.gates
      });
      let executionReadiness: ExecutionCompletionReadiness = { ok: true, issues: [] };
      try {
        executionReadiness = options.executionCompletionService.inspectTaskExecutionCompletion
          ? options.executionCompletionService.inspectTaskExecutionCompletion({
            taskId: payload.taskId,
            actor: payload.actor,
            documents: taskPackage.documents
          })
          : executionReadiness;
      } catch (error) {
        return taskFailure(payload.taskId, "write_rejected", error instanceof Error ? error.message : String(error));
      }
      const requirementIssues = collectCompletionRequirementIssues({
        taskId: payload.taskId,
        legacyReviewBlocker,
        documentPlaceholder,
        codeDocReconciliation,
        completionGate,
        executionReadiness
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
      const completion = yield* Effect.tryPromise({
        try: () => options.executionCompletionService!.completeTaskExecution({ taskId: payload.taskId, actor: payload.actor! }),
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
          "execution_completion_required",
          "Task completion requires a submitted Execution with a matching approved Review."
        );
      }
      return {
        ok: true,
        taskId: payload.taskId,
        executionId: completion.result.executionId,
        status: "done",
        completionGate
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

function validateLegacyReviewCompatibilityBlockers(
  artifactStore: Pick<ArtifactStore, "readTaskPackage">,
  taskId: string,
  reviewerId: string,
  now: (() => string) | undefined
): Effect.Effect<TaskLifecycleFailure | null> {
  return Effect.gen(function* () {
    const reviewBody = yield* readTaskDocument(artifactStore, taskId, "review.md");
    if (reviewBody === null || isReviewPlaceholderMarkdown(reviewBody)) return null;

    const parsed = parseReviewMarkdown(reviewBody);
    if (parsed.issues.length > 0) {
      return {
        ok: false,
        taskId,
        issues: parsed.issues,
        error: {
          code: "review_schema_invalid",
          hint: "Legacy review.md contains malformed material findings; repair or migrate them before typed completion."
        }
      };
    }
    if (parsed.findings.length === 0) return null;

    const gate = evaluateReviewGate({
      taskId,
      reviewerId,
      submittedAt: now ? now() : new Date().toISOString(),
      findings: parsed.findings
    });
    if (gate.ok) return null;
    return {
      ok: false,
      taskId,
      report: gate,
      issues: gate.issues,
      error: {
        code: "release_blocking_findings",
        hint: "Open release-blocking findings in legacy review.md must be closed or migrated before typed completion."
      }
    };
  });
}

function validateActiveTaskPlanPlaceholder(
  artifactStore: Pick<ArtifactStore, "readTaskPackage">,
  rootDir: string,
  layoutOverrides: HarnessLayoutOverrides | undefined,
  taskId: string,
  policy: TaskDocumentPlaceholderPolicy | undefined
): Effect.Effect<TaskLifecycleFailure | null> {
  return Effect.gen(function* () {
    if (!policy) return null;
    const taskPackage = yield* artifactStore.readTaskPackage(taskId as TaskId).pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (taskPackage === null) {
      const taskExists = readTaskProjection({ rootDir, layoutOverrides }).rows.some((row) => row.taskId === taskId);
      if (!taskExists) return taskFailure(taskId, "task_not_found", `task not found: ${taskId}`);
      return taskFailure(taskId, "task_plan_placeholder", "Read task_plan.md and replace scaffold content with a substantive implementation plan before transitioning the task to active.");
    }
    const taskPlan = taskPackage.documents.find((document) => document.path === "task_plan.md")?.body ?? null;
    if (taskPlan === null) {
      return taskFailure(taskId, "task_plan_placeholder", `Restore task_plan.md and write a substantive implementation plan before transitioning the task to active. Actual task directory read: ${taskPackage.rootPath}.`);
    }
    if (isTaskDocumentPlaceholderMarkdown(taskPlan, policy.taskPlanPlaceholderFingerprintSets)) {
      return taskFailure(
        taskId,
        "task_plan_placeholder",
        `Replace task_plan.md scaffold content with a substantive implementation plan before transitioning the task to active. Actual task directory read: ${taskPackage?.rootPath ?? "unavailable"}.`
      );
    }
    return null;
  });
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

function reviewTask(
  artifactStore: Pick<ArtifactStore, "readTaskPackage">,
  taskId: string,
  reviewerId: string,
  now: (() => string) | undefined
): Effect.Effect<TaskLifecycleResult> {
  return Effect.gen(function* () {
    const reviewBody = yield* readTaskDocument(artifactStore, taskId, "review.md");
    if (reviewBody === null) {
      return taskFailure(taskId, "review_document_missing", "Task review requires review.md in the task package.");
    }

    const parsed = parseReviewMarkdown(reviewBody);
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
  });
}

function readTaskDocument(artifactStore: Pick<ArtifactStore, "readTaskPackage">, taskId: string, documentPath: string): Effect.Effect<string | null> {
  return artifactStore.readTaskPackage(taskId as TaskId).pipe(
    Effect.map((taskPackage) => taskPackage.documents.find((document) => document.path === documentPath)?.body ?? null),
    Effect.catchAll(() => Effect.succeed(null))
  );
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
// that the CLI would coerce into a misleading completion_gate_failed. Values must
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

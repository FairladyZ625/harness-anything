import { Effect } from "effect";
import { CODE_DOC_RECONCILIATION_DOCUMENT, evaluateCodeDocReconciliationGate, makeTaskLifecycleOrchestrator, renderCodeDocReconciliationDraft, taskLifecycleTransitionId } from "@harness-anything/application";
import { makeLocalVersionControlSystem, requireDeterminateFlushReport, resolveHarnessLayout, type WriteError } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { preserveWriteErrorOrUnclassified } from "../../cli/write-error-classification.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { taskCompleteTransitionCommandFromCliAction } from "../../cli/task-complete-transition-command.ts";
import { bundledTaskDocumentPlaceholderPolicy } from "./task-document-placeholders.ts";
import { runExecutionReview } from "./task-execution-review.ts";
import { runExecutionConsent } from "./task-execution-consent.ts";
import { taskLifecycleResultToCliResult } from "./task-gate-receipt.ts";
import { authorityPlannerUnavailableHint } from "./authority-planner-unavailable.ts";
type TaskGateAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-code-doc-reconcile" | "task-review" | "task-consent-record" | "task-review-execution" | "task-complete" }>;
export const runTaskGatesCommand: CommandRunner = (context, command) => {
  const action = command.action as TaskGateAction;
  if (action.kind === "task-code-doc-reconcile") return runTaskCodeDocReconcile(context, action);
  if (action.kind === "task-consent-record") return runExecutionConsent(context, action);
  if (action.kind === "task-review-execution") return runExecutionReview(context, action);
  if (action.kind === "task-complete") {
    return runTaskLifecycleTransition(
      context,
      taskCompleteTransitionCommandFromCliAction(action)
    );
  }
  const orchestrator = makeTaskLifecycleOrchestrator({
    rootDir: context.rootDir,
    layoutOverrides: context.layoutOverrides,
    taskWriter: context.engine,
    artifactStore: context.artifactStore,
    documentPlaceholderPolicy: bundledTaskDocumentPlaceholderPolicy()
  });
  if (action.kind === "task-review") {
    return orchestrator.reviewTask({ taskId: action.taskId, reviewerId: action.reviewerId }).pipe(
      Effect.map((result): CliResult => taskLifecycleResultToCliResult("task-review", result))
    );
  }
  throw new Error(`unsupported task gate action: ${(action as { readonly kind: string }).kind}`);
};

function runTaskLifecycleTransition(
  context: Parameters<CommandRunner>[0],
  action: ReturnType<typeof taskCompleteTransitionCommandFromCliAction>
): ReturnType<CommandRunner> {
  if (action.dryRun === true) {
    if (!context.authorityCommandPreflight) {
      return Effect.succeed({
        ok: false,
        command: "task-complete",
        taskId: action.taskId,
        error: cliError(
          CliErrorCode.WriteRejected,
          authorityPlannerUnavailableHint(
            "Task completion dry-run is blocked because the canonical authority planner is unavailable; no completion requirement was evaluated."
          )
        )
      } satisfies CliResult);
    }
    const checkedGates = ["canonical-authority-planner", "task-completion-evidence"] as const;
    const uncheckedGates = ["durable-transition-write"] as const;
    const coordinator = context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "task-lifecycle-transition-dry-run" });
    return Effect.gen(function* () {
      // The canonical planner may run in the repo-write child. Keep the
      // parent-side read-only holder probe outside that preflight so the child
      // can run its own read-only planner without contending on a task lock.
      yield* requireDeterminateFlushReport(yield* coordinator.flush("explicit"));
      const holder = yield* Effect.tryPromise({
        try: () => context.taskHolderService.holder({ taskId: action.taskId }),
        catch: preserveWriteErrorOrUnclassified
      });
      if (holder.effectiveHolder) {
        return yield* Effect.fail({
          _tag: "WriteRejected",
          taskId: action.taskId,
          reason: `TASK_LIFECYCLE_HOLDER_RELEASE_REQUIRED:${action.taskId}`,
          retryable: false
        } satisfies WriteError);
      }
      return {
        ok: true,
        command: "task-complete",
        taskId: action.taskId,
        status: "in_review",
        completionGate: {
          ok: false,
          evidenceMode: action.evidenceMode,
          dryRun: true,
          checkedGates,
          uncheckedGates
        },
        report: {
          schema: "task-lifecycle-transition-preview/v1",
          dryRun: true,
          disposition: "canonical-authority-preflight-passed",
          checkedGates,
          uncheckedGates
        }
      } satisfies CliResult;
    });
  }
  if (!context.authorityCommandSubmission) {
    return Effect.succeed({
      ok: false,
      command: "task-complete",
      taskId: action.taskId,
      error: cliError(
        CliErrorCode.WriteRejected,
        authorityPlannerUnavailableHint(
          "Task completion requires the daemon-planned canonical transition submission, but the canonical authority planner is unavailable."
        )
      )
    } satisfies CliResult);
  }
  const transitionId = taskLifecycleTransitionId(action.callerIdempotencyKey);
  const coordinator = context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "task-lifecycle-transition" });
  return Effect.gen(function* () {
    const flush = yield* requireDeterminateFlushReport(yield* Effect.promise(() => context.taskHolderService.withUnheldTask(
      { taskId: action.taskId },
      () => Effect.runPromise(coordinator.flush("explicit"))
    )));
    if (!flush.committed && !flush.watermark) throw new Error("TASK_LIFECYCLE_TRANSITION_NOT_COMMITTED");
    return {
      ok: true,
      command: "task-complete",
      taskId: action.taskId,
      executionId: action.executionId ?? undefined,
      status: "done",
      completionGate: {
        ok: true,
        evidenceMode: action.evidenceMode,
        transitionId,
        checkpointSet: true
      },
      report: {
        schema: "task-lifecycle-transition-result/v1",
        transitionId,
        checkpointSet: action.externalCheckpointRefs ?? []
      }
    } satisfies CliResult;
  });
}

function runTaskCodeDocReconcile(
  context: Parameters<CommandRunner>[0],
  action: Extract<TaskGateAction, { readonly kind: "task-code-doc-reconcile" }>
): ReturnType<CommandRunner> {
  return Effect.gen(function* () {
    const taskPackage = yield* context.artifactStore.readTaskPackage(action.taskId);
    const existing = taskPackage.documents.find((document) => document.path === CODE_DOC_RECONCILIATION_DOCUMENT);
    if (existing && !action.force && !context.outerProceedingRecovery) {
      return {
        ok: false,
        command: action.kind,
        taskId: action.taskId,
        error: cliError(CliErrorCode.WriteRejected, `${CODE_DOC_RECONCILIATION_DOCUMENT} already exists; inspect it or rerun with --force to replace it.`)
      } satisfies CliResult;
    }

    const draft = renderCodeDocReconciliationDraft({
      taskId: action.taskId,
      documents: taskPackage.documents,
      sha: action.sha,
      paths: action.paths,
      prRef: action.prRef
    });
    if (draft.recordIds.length === 0) {
      return {
        ok: false,
        command: action.kind,
        taskId: action.taskId,
        error: cliError(CliErrorCode.WriteRejected, "Task package must contain closeout.md or review.md before code-doc reconciliation can be generated.")
      } satisfies CliResult;
    }

    const documents = [
      ...taskPackage.documents.filter((document) => document.path !== CODE_DOC_RECONCILIATION_DOCUMENT),
      { path: CODE_DOC_RECONCILIATION_DOCUMENT, body: draft.body }
    ];
    const evaluation = evaluateCodeDocReconciliationGate({
      taskId: action.taskId,
      documents,
      rootDir: context.rootDir,
      authoredRoot: resolveHarnessLayout(context.layoutInput).authoredRoot,
      versionControlSystem: makeLocalVersionControlSystem()
    });
    if (!evaluation.ok) {
      return {
        ok: false,
        command: action.kind,
        taskId: action.taskId,
        issues: evaluation.issues,
        error: cliError(CliErrorCode.WriteRejected, evaluation.issues.map((issue) => issue.message).join(" "))
      } satisfies CliResult;
    }

    const write = yield* context.engine.writeCodeDocReconciliation({
      taskId: action.taskId,
      body: draft.body
    });
    return {
      ok: true,
      command: action.kind,
      taskId: action.taskId,
      path: write.path,
      warnings: evaluation.warnings,
      report: {
        schema: "code-doc-reconcile-report/v1",
        recordIds: draft.recordIds,
        commit: action.sha,
        paths: action.paths,
        ...(typeof action.prRef === "string" ? { prRef: action.prRef } : {})
      }
    } satisfies CliResult;
  });
}

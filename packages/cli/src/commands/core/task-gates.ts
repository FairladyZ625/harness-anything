import path from "node:path";
import { Effect } from "effect";
import { CODE_DOC_RECONCILIATION_DOCUMENT, evaluateCodeDocReconciliationGate, makeExecutionCompletionService, makeTaskLifecycleOrchestrator, renderCodeDocReconciliationDraft, type TaskLifecycleResult } from "../../../../application/src/index.ts";
import { makeLocalVersionControlSystem, resolveHarnessLayout, taskDocumentPath } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode, isCliErrorCode, type CliErrorCode as CliErrorCodeValue } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { runDistillCommand } from "./distill.ts";
import { docSyncDirtyWarnings } from "./doc-sync.ts";
import { bundledTaskDocumentPlaceholderPolicy } from "./task-document-placeholders.ts";
import { taskTreeSoftGateWarnings } from "./task-lifecycle.ts";
import { runExecutionReview } from "./task-execution-review.ts";
import { milestoneDecisionLineageFailure } from "./task-lineage-gate.ts";
import { resolvePreset, selectPresetProfile } from "../extensions/state.ts";

type TaskGateAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-code-doc-reconcile" | "task-review" | "task-review-execution" | "task-complete" }>;

export const runTaskGatesCommand: CommandRunner = (context, command) => {
  const action = command.action as TaskGateAction;
  if (action.kind === "task-code-doc-reconcile") return runTaskCodeDocReconcile(context, action);
  if (action.kind === "task-review-execution") return runExecutionReview(context, action);
  const orchestrator = makeTaskLifecycleOrchestrator({
    rootDir: context.rootDir,
    layoutOverrides: context.layoutOverrides,
    taskWriter: context.engine,
    artifactStore: context.artifactStore,
    documentPlaceholderPolicy: bundledTaskDocumentPlaceholderPolicy(),
    codeDocVersionControlSystem: makeLocalVersionControlSystem(),
    executionCompletionService: makeExecutionCompletionService({
      rootInput: context.layoutInput,
      coordinator: context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "execution-completion" }),
      artifactStore: context.artifactStore
    }),
    completionGateResolver: ({ vertical, preset, profile }) => {
      const resolved = resolvePreset(context.layoutInput, preset!);
      if (!resolved) throw new Error(`Task preset is not resolvable in the current registry: ${preset}`);
      if (resolved.manifest.vertical !== vertical) throw new Error(`Task preset ${preset} does not belong to vertical ${vertical}`);
      if (resolved.manifest.schema !== "preset-manifest/v2") {
        throw new Error(`Task preset ${preset} does not declare a v2 completion contract`);
      }
      const selected = selectPresetProfile(resolved.manifest, profile);
      if (!selected || !("completionGates" in selected)) throw new Error(`Task preset profile is not resolvable: ${profile ?? resolved.manifest.defaultProfile}`);
      return selected.completionGates;
    }
  });
  if (action.kind === "task-review") {
    return orchestrator.reviewTask({ taskId: action.taskId, reviewerId: action.reviewerId }).pipe(
      Effect.map((result): CliResult => taskLifecycleResultToCliResult("task-review", result))
    );
  }
  const lineageFailure = milestoneDecisionLineageFailure(context, action.taskId);
  if (lineageFailure) return Effect.succeed(lineageFailure);
  return orchestrator.completeTask({ taskId: action.taskId, reviewerId: action.reviewerId, ciGate: action.ciGate, actor: context.taskHolderPrincipal() }).pipe(
    Effect.map((result): CliResult => {
      const output = taskLifecycleResultToCliResult("task-complete", result);
      if (!output.ok) return output;
      return { ...output, warnings: [...(taskTreeSoftGateWarnings(context, action.taskId) ?? []), ...(docSyncDirtyWarnings(context.layoutInput) ?? [])] };
    }),
    Effect.flatMap((output) => output.ok ? queueCloseoutDistillCandidate(context, command, action, output) : Effect.succeed(output))
  );
};

function runTaskCodeDocReconcile(
  context: Parameters<CommandRunner>[0],
  action: Extract<TaskGateAction, { readonly kind: "task-code-doc-reconcile" }>
): ReturnType<CommandRunner> {
  return Effect.gen(function* () {
    const taskPackage = yield* context.artifactStore.readTaskPackage(action.taskId);
    const existing = taskPackage.documents.find((document) => document.path === CODE_DOC_RECONCILIATION_DOCUMENT);
    if (existing && !action.force) {
      return {
        ok: false,
        command: action.kind,
        taskId: action.taskId,
        error: cliError(CliErrorCode.CodeDocReconciliationFailed, `${CODE_DOC_RECONCILIATION_DOCUMENT} already exists; inspect it or rerun with --force to replace it.`)
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
        error: cliError(CliErrorCode.CodeDocReconciliationFailed, "Task package must contain closeout.md or review.md before code-doc reconciliation can be generated.")
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
        error: cliError(CliErrorCode.CodeDocReconciliationFailed, evaluation.issues.map((issue) => issue.message).join(" "))
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
        prRef: action.prRef
      }
    } satisfies CliResult;
  });
}

function taskLifecycleResultToCliResult(command: "task-review" | "task-complete", result: TaskLifecycleResult): CliResult {
  if (result.ok) {
    return {
      ok: true,
      command,
      taskId: result.taskId,
      executionId: result.executionId,
      status: result.status,
      report: result.report,
      reviewContract: result.reviewContract,
      completionGate: result.completionGate
    };
  }
  return {
    ok: false,
    command,
    taskId: result.taskId,
    report: result.report,
    issues: result.issues,
    completionGate: result.completionGate,
    error: cliError(cliErrorCode(result.error.code), taskGateHint(result.error.code, result.error.hint, result.taskId))
  };
}

function queueCloseoutDistillCandidate(
  context: Parameters<CommandRunner>[0],
  command: Parameters<CommandRunner>[1],
  action: Extract<TaskGateAction, { readonly kind: "task-complete" }>,
  output: CliResult
): ReturnType<CommandRunner> {
  const inputPath = taskCloseoutInputPath(context, action.taskId);
  return runDistillCommand(context, {
    ...command,
    action: {
      kind: "distill-candidate",
      taskId: action.taskId,
      inputPath
    }
  }).pipe(
    Effect.match({
      onFailure: (error): CliResult => withDistillCandidateWarning(output, `distill candidate write failed: ${JSON.stringify(error)}`),
      onSuccess: (candidate): CliResult => candidate.ok
        ? withDistillCandidateReport(output, candidate)
        : withDistillCandidateWarning(output, candidate.error?.hint ?? "distill candidate was not queued")
    })
  );
}

function taskCloseoutInputPath(context: Parameters<CommandRunner>[0], taskId: string): string {
  return path.relative(context.rootDir, taskDocumentPath(context.layoutInput, taskId, "closeout.md")).split(path.sep).join("/");
}

function withDistillCandidateReport(output: CliResult, candidate: CliResult): CliResult {
  return {
    ...output,
    report: {
      ...(isCliReportRecord(output.report) ? output.report : { schema: "task-complete-report/v1" }),
      distillCandidate: {
        queued: true,
        path: candidate.path,
        report: candidate.report
      }
    }
  };
}

function withDistillCandidateWarning(output: CliResult, reason: string): CliResult {
  return {
    ...output,
    report: {
      ...(isCliReportRecord(output.report) ? output.report : { schema: "task-complete-report/v1" }),
      distillCandidate: {
        queued: false,
        reason
      }
    },
    warnings: [
      ...(output.warnings ?? []),
      {
        code: "distill_candidate_not_queued",
        message: reason
      }
    ]
  };
}

function isCliReportRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function taskGateHint(code: string, hint: string, taskId: string): string {
  if (/review\.md material findings table failed validation/i.test(hint)) return `${hint} Valid severity values: P0, P1, P2, P3.`;
  if (code === CliErrorCode.CodeDocReconciliationFailed) {
    return `${hint} Generate the required file with ha task code-doc reconcile ${taskId} --commit <full-sha> [--path <repo-relative-path>]... [--pr <url>].`;
  }
  if (code !== "closeout_not_ready" && !/closeout/i.test(hint)) return hint;
  return [
    hint,
    `To make closeoutReadiness ready/passed, replace closeout.md placeholder content with real Summary/Verification/Residual Risk. Submit an active Execution with a six-field packet and obtain an approved review-execution with rationale, or use ha task review ${taskId} for a legacy task. Then run ha task complete ${taskId}; add --ci passed only when the resolved completionGates declares ci (dec_mrg3z1we/CH1; ADR-0027 D3, D5, D7).`
  ].join(" ");
}

function cliErrorCode(code: string): CliErrorCodeValue {
  // The orchestrator's writeFailureCode maps every kernel writer/engine error to a
  // registered CLI error code, so a real write failure (e.g. malformed_snapshot,
  // write_rejected) passes through untouched and surfaces its true cause. The
  // CompletionGateFailed fallback is a defensive guard for an unexpected unregistered
  // code, not the normal path — it must not mask a recognized writer error code.
  if (isCliErrorCode(code)) return code;
  return CliErrorCode.CompletionGateFailed;
}

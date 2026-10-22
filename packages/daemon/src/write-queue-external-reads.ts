import path from "node:path";
import { type WriteReceiptDraft } from "@harness-anything/kernel";
import { artifactImportSourceResolution, prepareArtifactEntityImportSource } from "./artifact-entity-action.ts";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import { taskWorktreeInput } from "./repo-cell-action-dispatch.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { currentCutReviewForReturn, explicitExecutionId } from "./repo-cell-execution-selection.ts";
import { resolveStackedTaskBaseline } from "./stacked-task-start.ts";
import { prepareTaskStartWorktree, presetSnapshotReader, taskWorktreeBinding } from "./task-worktree.ts";
import { pushTaskWorkerBranch, workerPushFailureCode } from "./runtime-worker-push.ts";
import { requireCurrentExecutionScope } from "./runtime-execution-scope.ts";
import { detectHostingProvider } from "./hosting-provider.ts";
import { cellCriterionError } from "./repo-cell-errors.ts";

type QueuedPublication = ((
  action: RepoTaskAction,
  binding: RepoCellBinding,
) => WriteReceiptDraft | Promise<WriteReceiptDraft>) & {
  /**
   * Appends what was read as its own durable writes before the action executes, so the action's
   * receipt never claims them: a rejected action stays rejected even though its reads were recorded.
   */
  readonly ingest?: (binding: RepoCellBinding) => void;
};

// A URL artifact source, GitHub, or a task worktree's setup install can stall without bound, and every
// other write to the repository would wait behind it in the write queue. These finish first; only the
// returned publication of what they produced runs inside the queue.
export function readBeforeWriteQueue(
  context: RepoCellApiContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<QueuedPublication> | null {
  const baseline =
    action.kind === "task-start" && typeof action.taskId === "string"
      ? resolveStackedTaskBaseline(
          context.projection,
          action.taskId,
          typeof action.stackOn === "string" ? action.stackOn : undefined,
        )
      : undefined;
  const started = prepareTaskStartWorktree(
    taskWorktreeInput(context),
    action,
    binding.source,
    baseline?.kind === "commit" ? baseline.commitSha : undefined,
  );
  if (started)
    return started.then(
      (annotate) => async (action, binding) => annotate(await context.executeAction(action, binding)),
    );
  if (action.kind === "entity-import")
    return prepareArtifactEntityImportSource({
      rootDir: context.rootDir,
      repositoryId: context.input.repoId,
      action,
      projection: context.projection,
    }).then(
      (sourceResolution) => (action, binding) =>
        context.executeAction({ ...action, [artifactImportSourceResolution]: sourceResolution }, binding),
    );
  if (action.kind === "task-push") {
    // Everything, including the preflight, runs inside the async body: the caller turns a rejection
    // into an `op_rejected` receipt (`failAction`), while a synchronous throw would escape `run` as a
    // raw transport error — the operator would get no receipt, no code and no next action.
    return (async () => {
      const taskId = typeof action.taskId === "string" ? action.taskId : null;
      if (taskId === null) throw context.cellCodedError("invalid_command", "Task branch push requires a task id.");
      const task = context.projection.read(taskId).snapshot.task,
        worktree = taskWorktreeBinding(task, presetSnapshotReader(context.projection));
      if (!worktree)
        throw context.cellCodedError(
          "delivery_publish_failed",
          `Task ${taskId} has no Harness-managed repository worktree branch to publish.`,
        );
      const cwd = path.join(context.rootDir, worktree.path);
      if (binding.executionPrincipal)
        requireCurrentExecutionScope({
          action,
          binding,
          projection: context.projection,
          now: context.now(),
        });
      const instanceId = binding.executionPrincipal
          ? context.projection.readRuntimeDispatch(binding.executionPrincipal.runtimeSessionId)?.payload.instanceId
          : undefined,
        hosting = await detectHostingProvider(context.rootDir, undefined, true),
        daemonGitEnvironment =
          hosting && typeof instanceId === "string"
            ? await context.input.prepareDaemonGitEnvironment?.(instanceId, hosting.kind)
            : undefined;
      const gitEnvironment = daemonGitEnvironment
        ? {
            ...daemonGitEnvironment,
            GIT_ASKPASS: path.join(context.rootDir, "tools", "git-hooks", "git-askpass"),
            HARNESS_TASK_BOUND: "1",
          }
        : undefined;
      return async (_action: RepoTaskAction, _binding: RepoCellBinding) => {
        const pushed = await pushTaskWorkerBranch({
          cwd,
          canonicalRoot: context.rootDir,
          taskId,
          ...(gitEnvironment ? { env: gitEnvironment } : {}),
        });
        if (!pushed.attempted || !pushed.ok)
          throw context.cellCodedError(
            workerPushFailureCode(pushed),
            pushed.attempted ? pushed.detail : `Task branch push refused: ${pushed.reason}.`,
          );
        // `next` rides the receipt the same way the lifecycle settlement receipts carry it: as a
        // draft extension outside the kernel receipt schema.
        return context.withHumanSummary({
          outcome: "applied",
          opId: `task-push:${taskId}:${pushed.pushedCommit}`,
          revision: context.store.readHead()?.revision ?? 0,
          evidence: `Worker branch pushed: ${pushed.branch} @ ${pushed.pushedCommit}.`,
          next: [
            {
              command: `gh pr create --head ${taskId}`,
              reason: "open the task's pull request with the machine's own gh login",
            },
          ],
        } as WriteReceiptDraft);
      };
    })();
  }
  if (action.kind === "task-adjudicate" && action.forward === true && typeof action.taskId === "string") {
    const refused =
      typeof action.reviewer === "string"
        ? null
        : refuseAdjudicatedForwardBeforeQueue(context, action.taskId, explicitExecutionId(action));
    if (refused) return Promise.reject(refused);
  }
  return null;
}

const ADJUDICATE_VALIDATE_CRITERION = "task-lifecycle-adjudication-transitions/adjudicate.validate";

/** A forward on any submitted cut needs an explicit reviewer selection before the queue. */
function refuseAdjudicatedForwardBeforeQueue(
  context: RepoCellApiContext,
  taskId: string,
  executionId: string | undefined,
): Error | null {
  const { snapshot } = context.projection.read(taskId);
  if (
    !snapshot.task ||
    !["submitted", "in_review"].includes(snapshot.task.status) ||
    snapshot.task.currentNode !== "review"
  )
    return null;
  const review = currentCutReviewForReturn(snapshot, executionId),
    returnOrder = `ha task adjudicate ${taskId} --return${review ? ` --review-id ${review.reviewId}` : ""}`,
    forwardOrder = `ha task adjudicate ${taskId} --forward --reviewer <agent> --note "<why>"`;
  return cellCriterionError(
    "invalid_transition",
    `Task ${taskId} is at the review gate. Submit dispatches the frozen reviewer automatically; ` +
      `--forward requires an explicit --reviewer to select or replace the reviewer.` +
      (review ? ` Adjudicate the recorded verdict on the same cut with ${returnOrder}.` : ""),
    "adjudicate",
    ADJUDICATE_VALIDATE_CRITERION,
    [forwardOrder, ...(review ? [`${returnOrder} --note "<the owner's rework instruction>"`] : [])],
  );
}

import path from "node:path";
import { type WriteReceiptDraft } from "@harness-anything/kernel";
import { artifactImportSourceResolution, prepareArtifactEntityImportSource } from "./artifact-entity-action.ts";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import { taskWorktreeInput } from "./repo-cell-action-dispatch.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { currentCutReviewForReturn, explicitExecutionId } from "./repo-cell-execution-selection.ts";
import { resolveStackedTaskBaseline } from "./stacked-task-start.ts";
import { prepareTaskStartWorktree, presetSnapshotReader, taskWorktreeBinding } from "./task-worktree.ts";
import { pushTaskWorkerBranch } from "./runtime-worker-push.ts";
import { requireCurrentExecutionScope } from "./runtime-execution-scope.ts";
import { detectHostingProvider } from "./hosting-provider.ts";
import { createTaskPullRequest } from "./runtime-task-pr.ts";
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
    return (async () => {
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
            "delivery_publish_failed",
            pushed.attempted ? pushed.detail : `Task branch push refused: ${pushed.reason}.`,
          );
        return context.withHumanSummary({
          outcome: "applied",
          opId: `task-push:${taskId}:${pushed.pushedCommit}`,
          revision: context.store.readHead()?.revision ?? 0,
          evidence: `Worker branch pushed: ${pushed.branch} @ ${pushed.pushedCommit}.`,
        });
      };
    })();
  }
  if (action.kind === "task-pr") {
    return (async () => {
      return async (_action: RepoTaskAction, _binding: RepoCellBinding) => {
        return createTaskPullRequest(context, _action, _binding);
      };
    })();
  }
  if (action.kind === "task-adjudicate" && action.forward === true && typeof action.taskId === "string") {
    const refused = refuseAdjudicatedForwardBeforeQueue(context, action.taskId, explicitExecutionId(action));
    if (refused) return Promise.reject(refused);
  }
  return null;
}

const ADJUDICATE_VALIDATE_CRITERION = "task-lifecycle-adjudication-transitions/adjudicate.validate";

/**
 * A forward order on a cut that already passed the owner's triage is invalid under every
 * concurrent transition — nothing moves in_review back to submitted — so the refusal needs no
 * writer turn: it is answered here, before the write queue, instead of waiting behind a stalled
 * runtime publication. The queued kernel validation stays the authority for every other state.
 */
function refuseAdjudicatedForwardBeforeQueue(
  context: RepoCellApiContext,
  taskId: string,
  executionId: string | undefined,
): Error | null {
  const { snapshot } = context.projection.read(taskId);
  if (snapshot.task?.status !== "in_review" || snapshot.task.currentNode !== "review") return null;
  const review = currentCutReviewForReturn(snapshot, executionId),
    returnOrder = `ha task adjudicate ${taskId} --return${review ? ` --review-id ${review.reviewId}` : ""}`;
  return cellCriterionError(
    "invalid_transition",
    `Task ${taskId} is in review; a forward order only triages a fresh submitted cut, so this one is refused before ` +
      `the write queue. Adjudicate the recorded verdict on the same review cut instead: ${returnOrder}.`,
    "adjudicate",
    ADJUDICATE_VALIDATE_CRITERION,
    [`${returnOrder} --note "<the owner's rework instruction>"`],
  );
}

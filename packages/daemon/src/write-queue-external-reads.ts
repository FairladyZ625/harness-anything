import path from "node:path";
import { type WriteReceiptDraft } from "@harness-anything/kernel";
import { ingestCiObservations, preparedCiObservation, type CiObservationFetch } from "./ci-observation-actions.ts";
import type { ScheduleV1 } from "@harness-anything/kernel";
import { artifactImportSourceResolution, prepareArtifactEntityImportSource } from "./artifact-entity-action.ts";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import { taskWorktreeInput } from "./repo-cell-action-dispatch.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { resolveStackedTaskBaseline } from "./stacked-task-start.ts";
import { prepareTaskStartWorktree, presetSnapshotReader, taskWorktreeBinding } from "./task-worktree.ts";
import { pushTaskWorkerBranch } from "./runtime-worker-push.ts";
import { requireCurrentExecutionScope } from "./runtime-execution-scope.ts";

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
  refreshCi: (action: RepoTaskAction, binding: RepoCellBinding) => Promise<WriteReceiptDraft>,
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
  if (action.kind === "ci-observe-pull") {
    const fetched = (action as RepoTaskAction & { readonly [preparedCiObservation]?: CiObservationFetch })[
      preparedCiObservation
    ];
    if (fetched)
      return Promise.resolve((action, binding) => {
        const schedule = context.projection.getEntity("schedule", String(action.scheduleId))?.value as
          | ScheduleV1
          | undefined;
        if (!schedule?.status.activeRun || schedule.status.activeRun.claimFence !== action.claimFence)
          throw context.cellCodedError("schedule_claim_stale", "CI occurrence claim is no longer current.");
        return ingestCiObservations(context.extracted, binding, fetched);
      });
    return refreshCi(action, binding).then((receipt) => () => receipt);
  }
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
        workerGitEnvironment =
          typeof instanceId === "string" ? await context.input.prepareWorkerGitEnvironment?.(instanceId) : undefined;
      const gitEnvironment = workerGitEnvironment
        ? {
            ...workerGitEnvironment,
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
  return null;
}

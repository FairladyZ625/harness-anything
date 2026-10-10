import { type WriteReceiptDraft } from "@harness-anything/kernel";
import { ingestCiObservations, preparedCiObservation, type CiObservationFetch } from "./ci-observation-actions.ts";
import type { ScheduleV1 } from "@harness-anything/kernel";
import { artifactImportSourceResolution, prepareArtifactEntityImportSource } from "./artifact-entity-action.ts";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import { taskWorktreeInput } from "./repo-cell-action-dispatch.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { resolveStackedTaskBaseline } from "./stacked-task-start.ts";
import { prepareTaskStartWorktree } from "./task-worktree.ts";

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
  return null;
}

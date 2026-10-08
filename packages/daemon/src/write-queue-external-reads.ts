import {
  gateAppliesToSubmission,
  inferLegacyGateRequirements,
  type MappedWitnessAdapterId,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import { ingestCiObservations, preparedCiObservation, type CiObservationFetch } from "./ci-observation-actions.ts";
import type { ScheduleV1 } from "@harness-anything/kernel";
import { artifactImportSourceResolution, prepareArtifactEntityImportSource } from "./artifact-entity-action.ts";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import { taskWorktreeInput } from "./repo-cell-action-dispatch.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { resolveStackedTaskBaseline } from "./stacked-task-start.ts";
import { prepareTaskStartWorktree } from "./task-worktree.ts";
import { acceptedGateWitness, gateWaived, witnessAdapters, witnessCollections } from "./repo-cell-witness-adapters.ts";

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
  if ((action.kind === "task-submit" || action.kind === "task-complete") && typeof action.taskId === "string") {
    const snapshot = context.projection.read(action.taskId).snapshot,
      execution = snapshot.executions.find(
        (candidate) =>
          candidate.iteration === snapshot.task?.iteration &&
          candidate.submission &&
          (action.executionId === undefined || action.executionId === candidate.executionId),
      );
    if (execution && context.projection.readTaskCompletion(action.taskId, execution.executionId)) return null;
    if (!execution?.submission) return null;
    // Every adapter that can collect its own observations runs here, outside the queue; inside the
    // queue the collected values are re-judged against the frozen cut before any canonical write.
    // Cuts frozen before the contract carry no requirement list; their effective gates are
    // inferred from the rules in force at the time (ci -> github-actions, code-doc -> checker).
    const requirements =
      execution.submission.completionContract?.gates ??
      inferLegacyGateRequirements(
        snapshot.task?.completionGateIds ?? [],
        context.extracted.settings.read().ci.workflows,
      );
    const needsCi =
      action.kind === "task-complete" &&
      requirements.some(
        (requirement) =>
          requirement.witness.adapterId === "github-actions" &&
          gateAppliesToSubmission(requirement, execution.submission!) &&
          !acceptedGateWitness(snapshot, execution, requirement.gateId) &&
          !gateWaived(snapshot, execution, requirement) &&
          witnessAdapters["github-actions"].evaluate(context.extracted, requirement, execution, undefined)?.result !==
            "pass",
      );
    const pending = (
      execution.submission.completionContract?.gates ??
      inferLegacyGateRequirements(
        snapshot.task?.completionGateIds ?? [],
        context.extracted.settings.read().ci.workflows,
      )
    ).flatMap((requirement) => {
      // Submission freezes the delivery cut; GitHub observation belongs to the independent
      // center builtin occurrence and must never delay submit or its idempotent replay.
      if (action.kind === "task-submit" && requirement.witness.adapterId === "github-actions") return [];
      const adapter = witnessAdapters[requirement.witness.adapterId as MappedWitnessAdapterId];
      return adapter?.collect &&
        gateAppliesToSubmission(requirement, execution.submission!) &&
        !acceptedGateWitness(snapshot, execution, requirement.gateId) &&
        !gateWaived(snapshot, execution, requirement) &&
        // A recorded red verdict still collects: a newer run or rerun attempt may supersede it.
        adapter.evaluate(context.extracted, requirement, execution, undefined)?.result !== "pass"
        ? [{ requirement, adapter }]
        : [];
    });
    const refreshed = needsCi
      ? refreshCi({ kind: "ci-observe-pull", taskId: action.taskId }, binding)
      : Promise.resolve();
    if (needsCi && pending.length === 0)
      return refreshed.then(() => (action, binding) => context.executeAction(action, binding));
    if (pending.length)
      return Promise.all([
        refreshed,
        Promise.all(
          pending.map(async ({ requirement, adapter }) => {
            const collected = await adapter.collect!(context.extracted, requirement, execution).catch(
              (error: unknown) => {
                if (requirement.allowOverride !== true) throw error;
                throw context.extracted.cellCodedError(
                  (error as { readonly code?: string }).code ?? "witness_unavailable",
                  `${error instanceof Error ? error.message : String(error)} ` +
                    `The task owner may still break-glass this gate: ha task attest ${execution.taskId} ` +
                    `--gate ${requirement.gateId} --result pass --mode override ` +
                    "--rationale <why-no-automated-witness-is-acceptable>.",
                );
              },
            );
            return [requirement.gateId, { adapter, collected }] as const;
          }),
        ),
      ]).then(([, entries]) =>
        Object.assign(
          (action: RepoTaskAction, binding: RepoCellBinding) =>
            context.executeAction(
              {
                ...action,
                [witnessCollections]: new Map(entries.map(([gateId, { collected }]) => [gateId, collected])),
              },
              binding,
            ),
          {
            ingest: (binding: RepoCellBinding) => {
              for (const [, { adapter, collected }] of entries) adapter.ingest?.(context.extracted, binding, collected);
            },
          },
        ),
      );
  }
  return null;
}

import {
  gateAppliesToSubmission,
  inferLegacyGateRequirements,
  type MappedWitnessAdapterId,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import { artifactImportSourceResolution, prepareArtifactEntityImportSource } from "./artifact-entity-action.ts";
import { fetchCiObservations, ingestCiObservations } from "./ci-observation-actions.ts";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { acceptedGateWitness, gateWaived, witnessAdapters, witnessCollections } from "./repo-cell-witness-adapters.ts";

type QueuedPublication = (
  action: RepoTaskAction,
  binding: RepoCellBinding,
) => WriteReceiptDraft | Promise<WriteReceiptDraft>;

// A URL artifact source or GitHub can stall without bound, and every other write to the repository
// would wait behind it in the write queue. These reads finish first; only the returned publication
// of what they read runs inside the queue.
export function readBeforeWriteQueue(
  context: RepoCellApiContext,
  action: RepoTaskAction,
): Promise<QueuedPublication> | null {
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
  if (action.kind === "ci-observe-pull")
    return fetchCiObservations(context.extracted, action).then(
      (fetched) => (_action, binding) => ingestCiObservations(context.extracted, binding, fetched),
    );
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
    const pending = (
      execution.submission.completionContract?.gates ??
      inferLegacyGateRequirements(
        snapshot.task?.completionGateIds ?? [],
        context.extracted.settings.read().ci.workflows,
      )
    ).flatMap((requirement) => {
      // Submission freezes the delivery cut; GitHub observation belongs to the independent
      // `ci observe pull` or completion path and must never delay submit or its idempotent replay.
      if (action.kind === "task-submit" && requirement.witness.adapterId === "github-actions") return [];
      const adapter = witnessAdapters[requirement.witness.adapterId as MappedWitnessAdapterId];
      return adapter?.collect &&
        gateAppliesToSubmission(requirement, execution.submission!) &&
        !acceptedGateWitness(snapshot, execution, requirement.gateId) &&
        !gateWaived(snapshot, execution, requirement) &&
        adapter.evaluate(context.extracted, requirement, execution, undefined) === null
        ? [{ requirement, adapter }]
        : [];
    });
    if (pending.length)
      return Promise.all(
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
      ).then((entries) => async (action, binding) => {
        for (const [, { adapter, collected }] of entries) adapter.ingest?.(context.extracted, binding, collected);
        return context.executeAction(
          {
            ...action,
            [witnessCollections]: new Map(entries.map(([gateId, { collected }]) => [gateId, collected])),
          },
          binding,
        );
      });
  }
  return null;
}

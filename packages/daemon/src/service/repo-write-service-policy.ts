import type { makeLocalAgentHolderServices } from "../agent-runtime/holder-projection-host.ts";
import type { RepoWriteProcessSupervisor } from "../runtime/repo-write-process-supervisor.ts";

type TaskHolderService =
  ReturnType<typeof makeLocalAgentHolderServices>["taskHolderService"];

export function remainWedgedAfterFailedDrain(): Promise<never> {
  return new Promise(() => undefined);
}

export function registerRepoWriteSupervisorStops(
  stopHandlers: Array<() => Promise<void>>,
  supervisors: ReadonlyMap<string, RepoWriteProcessSupervisor> | undefined
): void {
  if (!supervisors) return;
  stopHandlers.push(async () => {
    const results = await Promise.allSettled(
      [...supervisors.values()].map((supervisor) => supervisor.stop())
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult =>
        result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "failed to stop repo writer children");
    }
  });
}

export function childOwnedTaskHolderService(
  service: TaskHolderService
): TaskHolderService {
  const rejected = async (): Promise<never> => {
    throw new Error(
      "REPO_WRITE_CHILD_COMMAND_NOT_ALLOWLISTED: task-holder mutation is disabled while the child writer is active"
    );
  };
  return {
    holder: service.holder,
    executionLeases: service.executionLeases,
    claim: rejected,
    release: rejected,
    assertActiveLease: rejected,
    assertActiveLeaseReadOnly: rejected,
    reserveExecution: rejected,
    withExecutionReservation: rejected,
    renewExecution: rejected,
    activateExecution: rejected,
    releaseExecution: rejected,
    assertExecutionLease: rejected,
    reconcileExecution: rejected
  };
}

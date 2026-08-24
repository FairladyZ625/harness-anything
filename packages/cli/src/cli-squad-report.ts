import type {
  RuntimeBatchDeclaration,
  RuntimeBatchResult,
  SquadDeclaration,
  SquadRunDispatch,
} from "./cli-types.ts";

export function squadRosterCoverage(
  squad: SquadDeclaration,
  plan: RuntimeBatchDeclaration,
): {
  readonly rosterWorkerIds: readonly string[];
  readonly rosterWorkerCount: number;
  readonly plannedWorkerIds: readonly string[];
  readonly plannedWorkerCount: number;
  readonly omittedWorkerIds: readonly string[];
} {
  const plannedWorkerIds = plan.dispatches.flatMap((entry) =>
    entry.to ? [entry.to] : [],
  );
  return {
    rosterWorkerIds: squad.workers,
    rosterWorkerCount: squad.workers.length,
    plannedWorkerIds,
    plannedWorkerCount: plannedWorkerIds.length,
    omittedWorkerIds: squad.workers.filter(
      (worker) => !plannedWorkerIds.includes(worker),
    ),
  };
}

export function squadReportRow(
  value: unknown,
  packagePath: string | null,
  squad: SquadDeclaration,
): SquadRunDispatch {
  const row = value as RuntimeBatchResult;
  return {
    ...row,
    agentId: row.to,
    delegatedByAgentId: squad.leader,
    squadId: squad.id,
    reportPath:
      packagePath && row.dispatchId
        ? `${packagePath}/artifacts/reports/${row.dispatchId}.md`
        : null,
  };
}

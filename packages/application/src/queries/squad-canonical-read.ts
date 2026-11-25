import {
  attributeEntityActionCriterion,
  dispatchLifecycleSummary,
  type CanonicalSquadRun,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { writeSourceNodeId } from "@harness-anything/kernel/internal/domain/write-source.ts";
import {
  activePhase,
  compareRunSummaries,
  listQuery,
  matchesRunQuery,
  runInActivityWindow,
  squadReadError,
} from "./squad-run-list.ts";
import {
  isAvailableSquadRunDetail,
  type SquadRunReadResult,
  type SquadRunsListResult,
  type SquadRunSummaryDto,
  type SquadRunTurnStatus,
} from "./squad-run-types.ts";

function squadCriterionError(code: string, message: string, actionId: string, criterionRef: string): Error {
  return attributeEntityActionCriterion(squadReadError(code, message), actionId, criterionRef, []);
}

/** Repository reads have no coordinator, dispatch stream, process or filesystem dependency. */
export function makeSquadCanonicalReader(input: {
  readonly projection: TaskProjectionQueries;
  readonly readResult: (ref: string) => string;
}) {
  const { projection } = input;
  function state(id: string): CanonicalSquadRun {
    if (!/^squad_[a-f0-9]{24}$/u.test(id))
      throw squadCriterionError(
        "invalid_squad_run_id",
        "Use the canonical Squad run handle.",
        "status",
        "squad/run-id",
      );
    const row = projection.readSquadRun(id);
    if (!row)
      throw squadCriterionError(
        "squad_run_not_found",
        `Squad run ${id} does not exist at this cut.`,
        "status",
        "squad/run-present",
      );
    return row.state as unknown as CanonicalSquadRun;
  }
  function attempt(runtimeSessionId: string | null, includeResult = true) {
    const session = runtimeSessionId ? projection.readRuntimeSession(runtimeSessionId) : null;
    const dispatch = runtimeSessionId ? projection.readRuntimeDispatch(runtimeSessionId) : null;
    const events = runtimeSessionId
      ? projection.readRuntimeSessionEventsByType(runtimeSessionId, ["runtime_session_outcome_observed"])
      : [];
    const outcome = events.findLast((row) => row.type === "runtime_session_outcome_observed");
    const metrics =
      outcome?.schema === "agent-runtime-event/v1" && outcome.type === "runtime_session_outcome_observed"
        ? outcome.payload.runtimeMetrics
        : null;
    const display = runtimeSessionId
      ? dispatchLifecycleSummary(projection.readDispatchLifecycle({ by: "session", runtimeSessionId })).displayStatus
      : null;
    const status: SquadRunTurnStatus | null = display === "blocked" ? "unknown" : display;
    return {
      status,
      startedAt: dispatch?.payload.startedAt ?? dispatch?.occurredAt ?? null,
      endedAt: session?.outcome ? session.lastObservedAt : null,
      tokenUsage: { input: metrics?.inputTokens ?? null, output: metrics?.outputTokens ?? null },
      toolCallCount: metrics?.toolCallCount ?? null,
      compacted: null,
      resultText: includeResult && session?.resultRef ? input.readResult(session.resultRef) : null,
    };
  }
  function identity(run: CanonicalSquadRun) {
    const subject = run.subject;
    if (subject.kind !== "task")
      return {
        executionId: null,
        iteration: null,
        currentIteration: null,
        runRevision: run.runRevision,
        acceptedRevision: run.acceptedRevision,
        acceptedAt: run.acceptedAt,
        owner: run.owner,
      };
    const snapshot = projection.read(subject.taskId).snapshot;
    return {
      executionId: subject.executionId,
      iteration: snapshot.executions.find((e) => e.executionId === subject.executionId)?.iteration ?? null,
      currentIteration: snapshot.task?.iteration ?? null,
      runRevision: run.runRevision,
      acceptedRevision: run.acceptedRevision,
      acceptedAt: run.acceptedAt,
      owner: run.owner,
    };
  }
  function summary(run: CanonicalSquadRun): SquadRunSummaryDto {
    return {
      ...identity(run),
      squadRunId: run.squadRunId,
      squadId: run.squadId,
      subject: run.subject,
      mission: run.mission,
      phase: run.phase,
      leaderTurnCount: run.leaderTurns.length,
      workerAttemptCount: run.workerAttempts.length,
      runningCount: [...run.leaderTurns, ...run.workerAttempts].filter(
        (entry) =>
          entry.runtimeSessionId &&
          dispatchLifecycleSummary(
            projection.readDispatchLifecycle({ by: "session", runtimeSessionId: entry.runtimeSessionId }),
          ).displayStatus === "running",
      ).length,
      latestActivityAt: run.acceptedAt,
    };
  }
  function read(id: string): SquadRunReadResult {
    const run = state(id),
      cut = projection.readCut();
    return {
      ok: true,
      ...cut,
      run: {
        ...identity(run),
        squadRunId: run.squadRunId,
        squadId: run.squadId,
        subject: run.subject,
        mission: run.mission,
        phase: run.phase,
        error: run.error,
        currentLeaderRuntimeSessionId: run.currentLeaderRuntimeSessionId,
        leaderTurns: run.leaderTurns.map((turn) => ({ ...turn, ...attempt(turn.runtimeSessionId) })),
        workerAttempts: run.workerAttempts.map((worker) => {
          const { resultText: _resultText, ...observed } = attempt(worker.runtimeSessionId, false);
          return {
            attemptId: worker.attemptId,
            workerId: worker.workerId,
            leaderTurnId: worker.leaderTurnId,
            dispatchId: worker.dispatchId,
            runtimeSessionId: worker.runtimeSessionId,
            rejection: worker.rejection,
            taskId: worker.taskId,
            executionId: worker.executionId,
            worktree:
              worker.branch !== null && worker.baseSha !== null
                ? { branch: worker.branch, baseSha: worker.baseSha }
                : null,
            ...observed,
          };
        }),
      },
    };
  }
  function list(payload: Readonly<Record<string, unknown>>): SquadRunsListResult {
    const { personId, nodeId, ...listPayload } = payload,
      query = listQuery(listPayload),
      rows = projection
        .readSquadRuns()
        .map((row) => row.state as unknown as CanonicalSquadRun)
        .filter(
          ({ owner }) =>
            (personId === undefined || owner.personId === personId) &&
            (nodeId === undefined || writeSourceNodeId(owner.source) === nodeId),
        )
        .map(summary)
        .filter((run) => activePhase(run.phase) || query.since === null || runInActivityWindow(run, query.since))
        .filter((run) => matchesRunQuery(run, query.tokens))
        .sort(compareRunSummaries);
    return {
      ok: true,
      ...projection.readCut(),
      runs: rows.slice(0, query.limit),
      totals: { runs: rows.length },
      truncated: rows.length > query.limit,
    };
  }
  function status(id: string): Record<string, unknown> {
    const run = state(id),
      detail = read(id).run;
    return {
      ...detail,
      status: run.phase,
      runRevision: run.runRevision,
      ...(isAvailableSquadRunDetail(detail) ? { executionId: detail.executionId } : {}),
      subject: run.subject,
      ownerDispatchId: run.ownerDispatchId,
      owner: run.owner,
      acceptedAt: run.acceptedAt,
      acceptedRevision: run.acceptedRevision,
      workerCallbackCount: run.workerCallbackCount,
      pendingLeaderCallbackCount: run.pendingLeaderCallbackCount,
      ...(activePhase(run.phase) ? {} : { exitCode: run.phase === "converged" ? 0 : 1 }),
      summary: `squad-run ${run.squadId}: ${run.phase}${run.error === null ? "" : ` — ${run.error}`}`,
    };
  }
  return { read, list, status };
}

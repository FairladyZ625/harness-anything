import {
  runtimeSessionSemanticState,
  type CanonicalSquadRun,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import {
  activePhase,
  compareRunSummaries,
  listQuery,
  matchesRunQuery,
  runInActivityWindow,
  squadReadError,
} from "./squad-run-list.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type {
  SquadRunReadResult,
  SquadRunsListResult,
  SquadRunSummaryDto,
  SquadRunTurnStatus,
} from "./squad-run-contract.ts";

/** Repository reads have no coordinator, dispatch stream, process or filesystem dependency. */
export function makeSquadCanonicalReader(input: {
  readonly projection: TaskProjectionQueries;
  readonly readResult: (ref: string) => string;
}) {
  const { projection } = input;
  function state(id: string): CanonicalSquadRun {
    if (!/^squad_[a-f0-9]{24}$/u.test(id))
      throw squadReadError("invalid_squad_run_id", "Use the canonical Squad run handle.");
    const row = projection.readSquadRun(id);
    if (!row) throw squadReadError("squad_run_not_found", `Squad run ${id} does not exist at this cut.`);
    return row.state as unknown as CanonicalSquadRun;
  }
  function attempt(runtimeSessionId: string | null) {
    const session = runtimeSessionId ? projection.readRuntimeSession(runtimeSessionId) : null;
    const dispatch = runtimeSessionId ? projection.readRuntimeDispatch(runtimeSessionId) : null;
    const events = runtimeSessionId
      ? projection.readRuntimeSessionEvents(runtimeSessionId, 0, Number.MAX_SAFE_INTEGER)
      : [];
    const outcome = events.findLast((row) => row.type === "runtime_session_outcome_observed");
    const metrics =
      outcome?.schema === "agent-runtime-event/v1" && outcome.type === "runtime_session_outcome_observed"
        ? outcome.payload.runtimeMetrics
        : null;
    const semantic = session ? runtimeSessionSemanticState(session) : null;
    const status: SquadRunTurnStatus | null =
      semantic === "ended-indeterminate" ? "unknown" : semantic === "unavailable" ? "lost" : semantic;
    return {
      status,
      startedAt: dispatch?.payload.startedAt ?? dispatch?.occurredAt ?? null,
      endedAt: session?.outcome ? session.lastObservedAt : null,
      tokenUsage: { input: metrics?.inputTokens ?? 0, output: metrics?.outputTokens ?? 0 },
      toolCallCount: metrics?.toolCallCount ?? 0,
      compacted: false,
      resultText: session?.resultRef?.startsWith("artifact:runtime-result/")
        ? input.readResult(session.resultRef)
        : null,
    };
  }
  function summary(run: CanonicalSquadRun): SquadRunSummaryDto {
    return {
      squadRunId: run.squadRunId,
      squadId: run.squadId,
      taskId: run.taskId,
      mission: run.mission,
      phase: run.phase,
      leaderTurnCount: run.leaderTurns.length,
      workerAttemptCount: run.workerAttempts.length,
      runningCount: [...run.leaderTurns, ...run.workerAttempts].filter(
        (entry) => entry.runtimeSessionId && projection.readRuntimeSession(entry.runtimeSessionId)?.outcome === null,
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
        squadRunId: run.squadRunId,
        squadId: run.squadId,
        taskId: run.taskId,
        mission: run.mission,
        phase: run.phase,
        error: run.error,
        currentLeaderRuntimeSessionId: run.currentLeaderRuntimeSessionId,
        leaderTurns: run.leaderTurns.map((turn) => ({ ...turn, ...attempt(turn.runtimeSessionId) })),
        workerAttempts: run.workerAttempts.map((worker) => {
          const { resultText: _resultText, ...observed } = attempt(worker.runtimeSessionId);
          return {
            attemptId: worker.attemptId,
            workerId: worker.workerId,
            leaderTurnId: worker.leaderTurnId,
            dispatchId: worker.dispatchId,
            runtimeSessionId: worker.runtimeSessionId,
            rejection: worker.rejection,
            worktree: null,
            ...observed,
          };
        }),
      },
    };
  }
  function list(payload: Readonly<Record<string, unknown>>): SquadRunsListResult {
    const query = listQuery(payload),
      rows = projection
        .readSquadRuns()
        .map((row) => summary(row.state as unknown as CanonicalSquadRun))
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
  function status(id: string): JsonObject {
    const run = state(id),
      detail = read(id).run;
    return {
      ...detail,
      status: run.phase,
      runRevision: run.runRevision,
      executionId: run.executionId,
      ownerDispatchId: run.ownerDispatchId,
      owner: run.owner,
      acceptedAt: run.acceptedAt,
      acceptedRevision: run.acceptedRevision,
      workerCallbackCount: run.workerCallbackCount,
      pendingLeaderCallbackCount: run.pendingLeaderCallbackCount,
      summary: `squad-run ${run.squadId}: ${run.phase}`,
    } as unknown as JsonObject;
  }
  return { read, list, status };
}

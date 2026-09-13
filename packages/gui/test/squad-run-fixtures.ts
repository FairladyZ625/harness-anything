/** Squad orchestration read fixtures shared by the runtime workspace interaction
 * suite: one summary row + list/detail envelopes kept DTO-complete in a single
 * place (tokenUsage/toolCallCount/compacted are required on every turn and
 * attempt since the P1.2 metrics exposure). */
export const emptySquadRuns = {
  ok: true as const,
  status: "ready" as const,
  runs: [],
  totals: { runs: 0 },
  truncated: false,
  watermark: 1,
  sourceRevision: 1,
};
export const squadRunSummaryRow = {
  squadRunId: "squad_" + "c".repeat(18),
  squadId: "core-squad",
  taskId: "task-bound",
  mission: "Probe the orchestration flow",
  phase: "converged" as const,
  leaderTurnCount: 2,
  workerAttemptCount: 1,
  runningCount: 0,
  latestActivityAt: "2026-08-23T02:00:00.000Z",
};
export const squadRunsListFixture = {
  ok: true as const,
  status: "ready" as const,
  runs: [squadRunSummaryRow],
  totals: { runs: 1 },
  truncated: false,
  watermark: 1,
  sourceRevision: 1,
};
export const squadRunDetailFixture = {
  ok: true as const,
  status: "ready" as const,
  run: {
    squadRunId: squadRunSummaryRow.squadRunId,
    squadId: "core-squad",
    taskId: "task-bound",
    mission: "Probe the orchestration flow",
    phase: "converged" as const,
    error: null,
    currentLeaderRuntimeSessionId: null,
    leaderTurns: [
      {
        turnId: "leader-1",
        trigger: { kind: "worker_outcome", runtimeSessionId: "runtime-worker" },
        dispatchId: "dispatch_000000000000000000000002",
        runtimeSessionId: "runtime-sibling",
        decision: { kind: "converged" },
        resultText: '{"schema":"squad-decision/v1","action":"converged"}',
        status: "succeeded" as const,
        startedAt: "2026-08-23T01:30:00.000Z",
        endedAt: "2026-08-23T01:40:00.000Z",
        tokenUsage: { input: 2400, output: 850 },
        toolCallCount: 5,
        compacted: false,
      },
    ],
    workerAttempts: [
      {
        attemptId: "worker-1",
        workerId: "terra",
        leaderTurnId: "leader-1",
        dispatchId: "dispatch_bbb",
        runtimeSessionId: "runtime-bound",
        worktree: null,
        rejection: null,
        status: "running" as const,
        startedAt: "2026-08-23T02:00:00.000Z",
        endedAt: null,
        tokenUsage: { input: 1200, output: 300 },
        toolCallCount: 2,
        compacted: false,
      },
    ],
  },
  watermark: 1,
  sourceRevision: 1,
};

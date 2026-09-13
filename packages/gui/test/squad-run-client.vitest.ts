// harness-test-tier: integration
import { afterEach, describe, expect, it, vi } from "vitest";
import { squadRunsClient } from "../src/renderer/squad-run-client.ts";

afterEach(() => vi.unstubAllGlobals());

describe("squad run read client", () => {
  it("reads squad runs through the list bridge with exact payloads", async () => {
    const run = {
      squadRunId: "squad_" + "a".repeat(18),
      squadId: "squad-x",
      taskId: "task-x",
      mission: "m",
      phase: "converged",
      leaderTurnCount: 1,
      workerAttemptCount: 1,
      runningCount: 0,
      latestActivityAt: "2026-08-26T00:00:00.000Z",
    } as const;
    const listSquadRuns = vi.fn(async () => ({
      ok: true,
      status: "ready",
      runs: [run],
      totals: { runs: 1 },
      truncated: false,
      watermark: 1,
      sourceRevision: 1,
    }));
    vi.stubGlobal("window", { harness: { listSquadRuns, readSquadRun: vi.fn() } });
    const listed = await squadRunsClient.list("repo-a", { since: "2026-08-26T00:00:00.000Z", query: "ontology" });
    expect(listed.runs).toHaveLength(1);
    expect(listSquadRuns).toHaveBeenCalledWith({
      repoId: "repo-a",
      since: "2026-08-26T00:00:00.000Z",
      query: "ontology",
    });
    vi.stubGlobal("window", {
      harness: { listSquadRuns: vi.fn(async () => ({ ok: true, runs: "no" })), readSquadRun: vi.fn() },
    });
    await expect(squadRunsClient.list("repo-a")).rejects.toThrow(/invalid result/u);
  });

  it("reads one squad run's orchestration flow through the read bridge and fails closed", async () => {
    const squadRunId = "squad_" + "a".repeat(18);
    const detail = {
      ok: true as const,
      status: "ready" as const,
      run: {
        squadRunId,
        squadId: "squad-x",
        taskId: "task-x",
        mission: "m",
        phase: "workers_running" as const,
        error: null,
        currentLeaderRuntimeSessionId: "runtime-leader",
        leaderTurns: [
          {
            turnId: "leader-1",
            trigger: { kind: "initial" },
            dispatchId: "dispatch-a",
            runtimeSessionId: "runtime-leader",
            decision: { kind: "plan", dispatchCount: 2 },
            resultText: null,
            status: "running",
            startedAt: "2026-08-26T00:00:00.000Z",
            endedAt: null,
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
            dispatchId: "dispatch-b",
            runtimeSessionId: "runtime-worker",
            worktree: null,
            rejection: null,
            status: null,
            startedAt: null,
            endedAt: null,
            tokenUsage: { input: 0, output: 0 },
            toolCallCount: 0,
            compacted: false,
          },
        ],
      },
      watermark: 1,
      sourceRevision: 1,
    };
    const readSquadRun = vi.fn(async () => detail);
    vi.stubGlobal("window", { harness: { listSquadRuns: vi.fn(), readSquadRun } });
    const read = await squadRunsClient.read("repo-a", squadRunId);
    expect(read.run.leaderTurns[0]?.decision).toEqual({ kind: "plan", dispatchCount: 2 });
    expect(readSquadRun).toHaveBeenCalledWith({ repoId: "repo-a", squadRunId });
    vi.stubGlobal("window", { harness: { listSquadRuns: vi.fn(), readSquadRun: vi.fn(async () => ({ ok: true })) } });
    await expect(squadRunsClient.read("repo-a", squadRunId)).rejects.toThrow(/invalid result/u);
  });
});

// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type CanonicalEventStore, type TaskProjection } from "../../kernel/src/index.ts";
import { makeSquadCoordinator } from "../src/squad-coordinator.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import { validateSquadRunRead } from "../src/squad-run-contract.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";

const LEADER_RESULT_SHA = "a".repeat(64),
  LEADER_RESULT = JSON.stringify({
    schema: "runtime-batch/v1",
    dispatches: [{ instance: "instance-squad", to: "sol", prompt: "dig the ontology seam" }],
  });

/** 与 production writeState 同构地种一个 run:leader-1 在跑(decision 未解析),
 * 归档结算行携带 outcome/resultRef,receipt 原文落在内容包里。 */
function seedRunningSquadRun(rootDir: string, squadRunId: string): void {
  openDispatchStream(rootDir, {
    dispatchId: "dispatch_00000000000000000000a1b2",
    taskId: "task-squad",
    executionId: "execution-squad",
    runtimeSessionId: "runtime-leader",
    instanceId: "instance-squad",
    startedAt: "2026-08-27T11:00:00.000Z",
  });
  appendRuntimeWorkerRecord(rootDir, "dispatch_00000000000000000000a1b2", {
    kind: "squad_run_state",
    squadRunId,
    revision: 2,
    state: {
      schema: "squad-run/v1",
      squadRunId,
      stateDispatchId: "dispatch_00000000000000000000a1b2",
      squadId: "core-squad",
      taskId: "task-squad",
      runtimeInstanceId: "instance-squad",
      cwd: rootDir,
      mission: "fan-out witness",
      model: null,
      effort: null,
      leaderAgentId: "terra",
      roster: "terra -> sol",
      workers: ["sol"],
      leaderTurnBudget: 8,
      binding: { actor: { principal: { personId: "person-squad" }, executor: null }, source: "local" },
      leaderTurns: [
        {
          turnId: "leader-1",
          trigger: { kind: "initial" },
          dispatchId: "dispatch_00000000000000000000a1b2",
          runtimeSessionId: "runtime-leader",
          decision: null,
        },
      ],
      leaderProviderSessionId: null,
      currentLeaderRuntimeSessionId: "runtime-leader",
      workerAttempts: [],
      observedWorkerRuntimeSessionIds: [],
      workerWaits: [],
      pendingLeaderTriggers: [],
      phase: "leader_running",
      revision: 2,
      error: null,
    },
  });
}

/** leader 派工的归档结算行:outcome/resultRef 是 receipt 原文的既有时实来源。 */
function leaderArchive(): Record<string, unknown> {
  return {
    schema: "runtime-dispatch/v1",
    dispatchId: "dispatch_00000000000000000000a1b2",
    taskId: "task-squad",
    executionId: "execution-squad",
    runtimeSessionId: "runtime-leader",
    instanceId: "instance-squad",
    startedAt: "2026-08-27T11:00:00.000Z",
    endedAt: "2026-08-27T11:04:00.000Z",
    outcome: "succeeded",
    resultRef: `artifact:runtime-result/sha256/${LEADER_RESULT_SHA}`,
  };
}

/** 与 squad-run-list-window 同款的投影桩,外加归档后的候选来源:归档结算行会把
 * 派工从 live index 摘除,之后的台账行必须仍能从任务会话 + dispatch 事件解析——
 * 否则 observeOutcome 落盘后的 read() 会丢行(生产投影正是这个形状)。 */
function projectionWith(archives: ReadonlyMap<string, Record<string, unknown>>): TaskProjection {
  const rows: { squadRunId: string; revision: number; state: unknown }[] = [];
  return {
    readTaskStatuses: () => ({ status: "ready", rows: [], watermark: 1, sourceRevision: 1 }),
    readTaskRuntimeBatch: (query: { readonly taskIds: readonly string[] }) => ({
      status: "ready" as const,
      taskIds: query.taskIds,
      rows: query.taskIds.map((taskId) => ({
        taskId,
        title: "Squad detail witness",
        packagePath: `tasks/${taskId}`,
        sessions:
          taskId === "task-squad"
            ? [
                {
                  runtimeSessionId: "runtime-leader",
                  instanceId: "instance-squad",
                  installationId: "installation-squad",
                  kindId: "codex",
                  definitionSnapshotRef: "artifact:runtime-definition/squad",
                  providerSessionId: null,
                  transcriptRef: null,
                  launchGeneration: 1,
                  liveness: "exited",
                  attachable: false,
                  taskBindings: [],
                  outcome: "succeeded",
                  exitCode: 0,
                  resultRef: null,
                  lastObservedAt: "2026-08-27T11:04:00.000Z",
                },
              ]
            : [],
      })),
      watermark: 1,
      sourceRevision: 1,
    }),
    readRuntimeDispatch: (runtimeSessionId: string) =>
      runtimeSessionId === "runtime-leader"
        ? {
            type: "runtime_dispatch_requested",
            payload: { dispatchId: "dispatch_00000000000000000000a1b2", runtimeSessionId },
          }
        : null,
    readDocument: (documentPath: string) => {
      const archive = archives.get(/dispatch_[a-f0-9]{24}/u.exec(documentPath)?.[0] ?? "");
      return {
        status: "ready" as const,
        document: archive === undefined ? null : { body: JSON.stringify(archive) },
        watermark: 1,
        sourceRevision: 1,
      };
    },
    squadRunProjectionReady: () => rows.length > 0,
    replaceSquadRuns: (value: typeof rows) => {
      rows.length = 0;
      rows.push(...value);
    },
    upsertSquadRun: (row: (typeof rows)[number]) => {
      const known = rows.findIndex((candidate) => candidate.squadRunId === row.squadRunId);
      if (known >= 0 && rows[known]!.revision > row.revision) return;
      if (known >= 0) rows[known] = row;
      else rows.push(row);
    },
    markSquadRunProjectionDirty: () => undefined,
    readSquadRuns: () => rows,
    readSquadRun: (squadRunId: string) => rows.find((row) => row.squadRunId === squadRunId) ?? null,
    readRuntimeSession: () => null,
  } as unknown as TaskProjection;
}

function coordinator(
  rootDir: string,
  options: { readonly receiptBlob: Uint8Array | null } = { receiptBlob: new TextEncoder().encode(LEADER_RESULT) },
) {
  // 投影必须是稳定实例:coordinator 的 upsertSquadRun memo 落在同一个 rows 上。
  const projection = projectionWith(new Map([["dispatch_00000000000000000000a1b2", leaderArchive()]]));
  return makeSquadCoordinator({
    rootDir,
    projection: () => projection,
    store: () =>
      ({
        readContentBlob: (sha256: string) => (sha256 === LEADER_RESULT_SHA ? options.receiptBlob : null),
      }) as unknown as CanonicalEventStore,
    reacquireTaskLease: async () => undefined,
    runtimeSpawner: () => ({
      spawn: async (): Promise<JsonObject> => ({
        ok: true,
        dispatchId: "dispatch_00000000000000000000b2c3",
        runtimeSessionId: "runtime-worker-1",
      }),
      cancel: async (): Promise<JsonObject> => ({ ok: true, outcome: "applied" }),
    }),
  });
}

const leaderOutcome = (runtimeSessionId: string) =>
  ({
    schema: "agent-runtime-event/v1",
    eventId: "event-outcome",
    workspaceRevision: 4,
    opId: "op-outcome",
    actor: { principal: { personId: "person-squad" }, executor: null },
    source: "local",
    occurredAt: new Date().toISOString(),
    type: "runtime_session_outcome_observed",
    payload: { runtimeSessionId, outcome: "succeeded", exitCode: 0, resultRef: null },
  }) as Parameters<ReturnType<typeof makeSquadCoordinator>["observeOutcome"]>[0];

test("a settled leader turn carries its receipt verbatim and its dispatches link back to the turn", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-detail-"));
  try {
    seedRunningSquadRun(rootDir, "squad_0123456789abcdef01234567");
    const squad = coordinator(rootDir);
    // 真实写路径:leader 结算 → 决策解析 → spawnWorker 落盘(带 leaderTurnId)。
    await squad.observeOutcome(leaderOutcome("runtime-leader"));
    const detail = squad.read("squad_0123456789abcdef01234567");
    assert.equal(detail.run.leaderTurns[0]?.decision?.kind, "plan");
    assert.equal(detail.run.leaderTurns[0]?.resultText, LEADER_RESULT);
    assert.equal(detail.run.workerAttempts[0]?.leaderTurnId, "leader-1");
    assert.equal(detail.run.workerAttempts[0]?.workerId, "sol");
    assert.equal(detail.run.workerAttempts[0]?.runtimeSessionId, "runtime-worker-1");
    assert.deepEqual(validateSquadRunRead(detail), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a pruned or missing receipt blob reads as null instead of failing the detail read", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-detail-"));
  try {
    seedRunningSquadRun(rootDir, "squad_0123456789abcdef01234567");
    const squad = coordinator(rootDir, { receiptBlob: null });
    await squad.observeOutcome(leaderOutcome("runtime-leader"));
    const detail = squad.read("squad_0123456789abcdef01234567");
    assert.equal(detail.run.leaderTurns[0]?.resultText, null);
    assert.deepEqual(validateSquadRunRead(detail), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

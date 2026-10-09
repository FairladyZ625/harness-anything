// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TaskProjection } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord, archiveDispatchStream, openDispatchStream } from "../src/dispatch-stream.ts";
import {
  agentRuntimeTokenUsageRanges,
  readAgentRuntimeTokenUsage,
  readAgentRuntimeTokenUsageDetail,
  serializeAgentRuntimeTokenUsage,
  serializeAgentRuntimeTokenUsageDetail,
  tokenUsageInsightLimits,
  tokenUsageSessionBinCeilings,
  validateAgentRuntimeTokenUsage,
  validateAgentRuntimeTokenUsageDetail,
} from "../src/agent-runtime-token-usage.ts";
import { daemonGuiReadMethods, validateDaemonRpcCall } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";

const NOW = "2026-09-14T12:00:00.000Z",
  CUT = { status: "ready" as const, watermark: 7, sourceRevision: 7 },
  EMPTY_PROJECTION = { readRuntimeDispatchPage: () => ({ rows: [], nextCursor: null, done: true }) };

/** 任务索引夹具:task-a/task-b 属于声明的工作 work-root,task-solo 自成一个工作,task-tokens 不在索引里。 */
const TASKS = new Map(
  (
    [
      ["work-root", "发布线", "work", null],
      ["task-a", "接入读面", "task", "work-root"],
      ["task-b", "补回归测试", "task", "work-root"],
      ["task-solo", "独立小改", "task", null],
    ] as const
  ).map(([taskId, title, taskClass, parentTaskId]) => [taskId, { taskId, title, taskClass, parentTaskId }]),
);

function metrics(input: number, cache: number, output: number, tools: number, usageUnavailable = false) {
  return {
    kind: "runtime_metrics",
    inputTokens: input,
    cacheReadTokens: cache,
    outputTokens: output,
    totalTokens: input + cache + output,
    toolCallCount: tools,
    compacted: false,
    raw: { input_tokens: input, output_tokens: output },
    ...(usageUnavailable ? { usageUnavailable: true } : {}),
  };
}

/** 种今天的派工流:归因(agent/squad/runtimeSession)与 metrics 都在流里,和 production 写入同构。 */
function seedToday(rootDir: string): void {
  openDispatchStream(rootDir, {
    dispatchId: "dispatch_00000000000000000000aa01",
    taskId: "task-tokens",
    executionId: "execution-1",
    runtimeSessionId: "runtime-terra",
    instanceId: "instance-codex",
    startedAt: NOW,
    agentId: "terra",
    agentName: "Terra",
    squadId: "core-squad",
    model: "gpt-test",
  });
  appendRuntimeWorkerRecord(rootDir, "dispatch_00000000000000000000aa01", metrics(100, 20, 30, 4));
  // terra 的第二个 attempt:同一 runtimeSession,metrics 另算 —— 会话数不涨,token 相加。
  openDispatchStream(rootDir, {
    dispatchId: "dispatch_00000000000000000000aa02",
    taskId: "task-tokens",
    executionId: "execution-1",
    runtimeSessionId: "runtime-terra",
    instanceId: "instance-codex",
    startedAt: NOW,
    agentId: "terra",
    agentName: "Terra",
  });
  appendRuntimeWorkerRecord(rootDir, "dispatch_00000000000000000000aa02", metrics(50, 0, 10, 1));
  // provider 不上报用量的派工:零计数是「缺数」,不是「真花了 0」。
  openDispatchStream(rootDir, {
    dispatchId: "dispatch_00000000000000000000aa03",
    taskId: "task-tokens",
    executionId: "execution-2",
    runtimeSessionId: "runtime-sol",
    instanceId: "instance-claude",
    startedAt: NOW,
    agentId: "sol",
    agentName: "Sol",
    model: "opus-test",
  });
  appendRuntimeWorkerRecord(rootDir, "dispatch_00000000000000000000aa03", metrics(0, 0, 0, 2, true));
  // 无 metrics 的派工:会话仍计数,token 为零,不算已上报也不算未上报。
  openDispatchStream(rootDir, {
    dispatchId: "dispatch_00000000000000000000aa06",
    taskId: "task-tokens",
    executionId: "execution-5",
    runtimeSessionId: "runtime-running",
    instanceId: "instance-codex",
    startedAt: NOW,
    agentId: "luna",
    agentName: "Luna",
  });
  // 无 agent 归因、归 squad 的派工:只进 squad 视图。
  openDispatchStream(rootDir, {
    dispatchId: "dispatch_00000000000000000000aa04",
    taskId: "task-tokens",
    executionId: "execution-3",
    runtimeSessionId: "runtime-direct",
    instanceId: "instance-codex",
    startedAt: NOW,
    squadId: "core-squad",
  });
  appendRuntimeWorkerRecord(rootDir, "dispatch_00000000000000000000aa04", metrics(10, 0, 5, 1));
  // 两天前的派工:不在「今天」窗口,但在 7 天窗口里。
  openDispatchStream(rootDir, {
    dispatchId: "dispatch_00000000000000000000aa05",
    taskId: "task-tokens",
    executionId: "execution-4",
    runtimeSessionId: "runtime-old",
    instanceId: "instance-codex",
    startedAt: "2026-09-12T12:00:00.000Z",
    agentId: "terra",
    agentName: "Terra",
  });
  appendRuntimeWorkerRecord(rootDir, "dispatch_00000000000000000000aa05", metrics(999, 0, 999, 99));
}

function read(rootDir: string, now = NOW, range: (typeof agentRuntimeTokenUsageRanges)[number] = "today") {
  return readAgentRuntimeTokenUsage({
    rootDir,
    now,
    range,
    entityLabel: (squadId) => (squadId === "core-squad" ? "Core" : null),
    taskOf: (taskId) => TASKS.get(taskId),
    cut: CUT,
    projection: EMPTY_PROJECTION,
  });
}

test("archived settlements retain usage without a projected outcome", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-archive-"));
  try {
    seedToday(rootDir);
    const ids = ["dispatch_00000000000000000000aa01", "dispatch_00000000000000000000aa03"];
    for (const id of ids) archiveDispatchStream(rootDir, id);
    const rows: ReturnType<TaskProjection["readRuntimeDispatchPage"]>["rows"] = ids.map((dispatchId, index) => ({
      event: {
        schema: "agent-runtime-event/v1",
        eventId: dispatchId,
        workspaceRevision: index + 1,
        opId: dispatchId,
        actor: { principal: { personId: "fixture" }, executor: null },
        source: "local",
        occurredAt: NOW,
        type: "runtime_dispatch_requested",
        payload: {
          dispatchId,
          runtimeSessionId: index === 0 ? "runtime-terra" : "runtime-sol",
          instanceId: "instance-codex",
          installationId: "installation-test",
          kindId: "codex",
          idempotencyKey: dispatchId,
          definitionSnapshotRef: "artifact:runtime-definition/test",
          startedAt: NOW,
          agentId: index === 0 ? "terra" : "sol",
          squadId: "core-squad",
          definitionSnapshot: {
            schema: "agent-definition-snapshot/v1",
            configVersion: 1,
            instanceId: "instance-codex",
            installationId: "installation-test",
            kindId: "codex",
            providerId: "openai",
            model: "gpt-test",
            reasoningEffort: null,
            baseUrl: null,
            authMode: "subscription",
          },
        },
      },
      metrics: null,
      endedAt: null,
      outcome: null,
    }));
    const projection = { readRuntimeDispatchPage: () => ({ rows, done: true, nextCursor: null }) };
    const input = {
      rootDir,
      now: NOW,
      range: "today" as const,
      entityLabel: () => null,
      taskOf: () => undefined,
      cut: CUT,
      projection,
    };
    const aggregate = readAgentRuntimeTokenUsage(input);
    assert.equal(aggregate.totals.totalTokens, 225);
    assert.equal(aggregate.totals.usageUnavailableDispatches, 1);
    assert.equal(aggregate.agents.find(({ agentId }) => agentId === "terra")?.totalTokens, 210);
    const detail = readAgentRuntimeTokenUsageDetail({ ...input, member: { kind: "agent", agentId: "sol" } });
    assert.equal(detail.sessions[0]?.usage, "unavailable");
    assert.equal(detail.totals.usageUnavailableDispatches, 1);
    assert.equal(
      detail.buckets.reduce((n, bucket) => n + bucket.usageUnavailableDispatches, 0),
      1,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("settled dispatches without metrics are unavailable while live dispatches remain pending", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-missing-"));
  try {
    const dispatchId = "dispatch_00000000000000000000bb01";
    openDispatchStream(rootDir, {
      dispatchId,
      runtimeSessionId: "runtime-missing",
      instanceId: "instance-test",
      taskId: null,
      executionId: null,
      startedAt: NOW,
      agentId: "sol",
      squadId: "core-squad",
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 123 });
    const input = {
      rootDir,
      now: NOW,
      range: "today" as const,
      entityLabel: () => null,
      projection: EMPTY_PROJECTION,
      cut: CUT,
    };
    const member = { kind: "agent" as const, agentId: "sol" };
    assert.equal(readAgentRuntimeTokenUsageDetail({ ...input, member }).sessions[0]?.usage, "pending");
    assert.equal(read(rootDir).totals.usageUnavailableDispatches, 0);
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: 0, signal: null });
    const result = read(rootDir);
    assert.equal(result.totals.totalTokens, 0);
    assert.equal(result.totals.usageUnavailableDispatches, 1);
    assert.equal(result.agents[0]?.usageUnavailableDispatches, 1);
    assert.equal(result.squads[0]?.usageUnavailableDispatches, 1);
    assert.equal(
      result.buckets.reduce((n, b) => n + b.usageUnavailableDispatches, 0),
      1,
    );
    const detail = readAgentRuntimeTokenUsageDetail({ ...input, member });
    assert.equal(detail.sessions[0]?.usage, "unavailable");
    assert.equal(detail.totals.usageUnavailableDispatches, 1);
    assert.equal(
      detail.buckets.reduce((n, b) => n + b.usageUnavailableDispatches, 0),
      1,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readAgentRuntimeTokenUsage aggregates today per agent and squad from dispatch streams", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-"));
  try {
    seedToday(rootDir);
    const result = read(rootDir);
    assert.deepEqual(result.agents, [
      {
        agentId: "terra",
        agentName: "Terra",
        sessionCount: 1,
        inputTokens: 150,
        cacheReadTokens: 20,
        outputTokens: 40,
        totalTokens: 210,
        toolCallCount: 5,
        usageReportedDispatches: 2,
        usageUnavailableDispatches: 0,
        succeededSessions: 0,
        failedSessions: 0,
        abortedSessions: 0,
        costUsd: 0,
        unpricedTokens: 210,
      },
      {
        agentId: "luna",
        agentName: "Luna",
        sessionCount: 1,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        toolCallCount: 0,
        usageReportedDispatches: 0,
        usageUnavailableDispatches: 0,
        succeededSessions: 0,
        failedSessions: 0,
        abortedSessions: 0,
        costUsd: 0,
        unpricedTokens: 0,
      },
      {
        agentId: "sol",
        agentName: "Sol",
        sessionCount: 1,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        toolCallCount: 2,
        usageUnavailableDispatches: 1,
        usageReportedDispatches: 0,
        succeededSessions: 0,
        failedSessions: 0,
        abortedSessions: 0,
        costUsd: 0,
        unpricedTokens: 0,
      },
    ]);
    assert.deepEqual(result.squads, [
      {
        squadId: "core-squad",
        squadName: "Core",
        sessionCount: 2,
        inputTokens: 110,
        cacheReadTokens: 20,
        outputTokens: 35,
        totalTokens: 165,
        toolCallCount: 5,
        usageReportedDispatches: 2,
        usageUnavailableDispatches: 0,
        succeededSessions: 0,
        failedSessions: 0,
        abortedSessions: 0,
        costUsd: 0,
        unpricedTokens: 165,
      },
    ]);
    assert.equal(result.status, "ready");
    assert.equal(result.range, "today");
    assert.equal(result.watermark, 7);
    assert.deepEqual(result.totals, {
      sessionCount: 4,
      inputTokens: 160,
      cacheReadTokens: 20,
      outputTokens: 45,
      totalTokens: 225,
      toolCallCount: 8,
      usageReportedDispatches: 3,
      usageUnavailableDispatches: 1,
      costUsd: 0,
      unpricedTokens: 225,
    });
    const since = new Date(result.since);
    assert.ok(
      since.getTime() <= Date.parse(NOW) && Date.parse(NOW) < since.getTime() + 24 * 60 * 60 * 1_000,
      `since ${result.since} must be the local day of ${NOW}`,
    );
    assert.deepEqual(
      [since.getHours(), since.getMinutes(), since.getSeconds(), since.getMilliseconds()],
      [0, 0, 0, 0],
      "since is local midnight on the daemon clock",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("today slices hourly buckets and the multi-day ranges widen the window monotonically", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-buckets-"));
  try {
    seedToday(rootDir);
    const today = read(rootDir),
      week = read(rootDir, NOW, "7d");
    assert.equal(today.bucketMs, 3_600_000);
    // 12:00 的派工落 12:00 桶;桶梯从零点到当前小时,没有未来桶。
    const noon = today.buckets.find(({ bucketStart }) => bucketStart.endsWith("T12:00:00.000Z"));
    assert.ok(noon, "the bucket covering 12:00 exists");
    assert.deepEqual(
      [noon.dispatchCount, noon.inputTokens, noon.totalTokens, noon.usageReportedDispatches],
      [5, 160, 225, 3],
      "today's five in-window dispatches all land in the 12:00 hour bucket",
    );
    assert.ok(
      today.buckets.every(({ bucketStart }) => Date.parse(bucketStart) <= Date.parse(NOW)),
      "no bucket starts after now",
    );
    assert.equal(new Date(today.since).toISOString(), new Date(new Date(NOW).setHours(0, 0, 0, 0)).toISOString());
    assert.equal(week.bucketMs, 86_400_000);
    assert.equal(
      new Date(week.since).getDate(),
      new Date(NOW).getDate() - 6,
      "the 7d window starts six calendar days back",
    );
    // 阴性对照(证据协议):窗口放大,总量单调不减。
    assert.ok(week.totals.totalTokens >= today.totals.totalTokens);
    assert.ok(week.agents.find(({ agentId }) => agentId === "terra")!.totalTokens >= 210);
    const month = read(rootDir, NOW, "30d");
    assert.ok(month.totals.totalTokens >= week.totals.totalTokens);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("token history pagination stops on reader done, not cursor presence", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-pages-"));
  try {
    let reads = 0;
    const result = readAgentRuntimeTokenUsage({
      rootDir,
      now: NOW,
      range: "30d",
      entityLabel: () => null,
      taskOf: () => undefined,
      cut: CUT,
      projection: {
        readRuntimeDispatchPage: () => {
          reads += 1;
          return reads === 1
            ? {
                rows: [],
                nextCursor: { startedAt: "2026-09-01T00:00:00.000Z", dispatchId: "dispatch_cursor" },
                done: false,
              }
            : { rows: [], nextCursor: { startedAt: "2099-01-01T00:00:00.000Z", dispatchId: "tail" }, done: true };
        },
      },
    });
    assert.equal(result.totals.totalTokens, 0);
    assert.equal(reads, 2, "a terminal page may carry a cursor and must not trigger a third read");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("agent runtime token usage rows sort by total tokens descending", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-sort-"));
  try {
    for (const [index, agent] of ["small", "big", "mid"].entries()) {
      const dispatchId = `dispatch_${(0xb0 + index).toString(16).padStart(24, "0")}`;
      openDispatchStream(rootDir, {
        dispatchId,
        taskId: "task-tokens",
        executionId: "execution-1",
        runtimeSessionId: `runtime-${agent}`,
        instanceId: "instance-codex",
        startedAt: NOW,
        agentId: agent,
      });
      appendRuntimeWorkerRecord(
        rootDir,
        dispatchId,
        metrics(agent === "big" ? 900 : agent === "mid" ? 500 : 100, 0, 0, 0),
      );
    }
    const result = read(rootDir);
    assert.deepEqual(
      result.agents.map(({ agentId }) => agentId),
      ["big", "mid", "small"],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readAgentRuntimeTokenUsageDetail scopes sessions, trend and totals to one member", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-detail-"));
  try {
    seedToday(rootDir);
    const detail = readAgentRuntimeTokenUsageDetail({
      rootDir,
      now: NOW,
      range: "today",
      member: { kind: "agent", agentId: "terra" },
      entityLabel: () => null,
      cut: CUT,
      projection: EMPTY_PROJECTION,
    });
    assert.deepEqual(detail.member, { kind: "agent", agentId: "terra", agentName: "Terra" });
    assert.equal(detail.totals.sessionCount, 1);
    assert.equal(detail.totals.totalTokens, 210);
    assert.equal(detail.totals.usageReportedDispatches, 2);
    assert.deepEqual(
      detail.sessions.map(({ dispatchId }) => dispatchId),
      ["dispatch_00000000000000000000aa01", "dispatch_00000000000000000000aa02"],
    );
    const first = detail.sessions[0]!;
    assert.equal(first.runtimeSessionId, "runtime-terra");
    assert.equal(first.taskId, "task-tokens");
    assert.equal(first.model, "gpt-test");
    assert.equal(first.usage, "reported");
    assert.ok(first.outcome === "running" || first.outcome === "unknown", "no settled process record yet");
    // 未上报成员的阴性对照:token 全零时明细行必须携带 unavailable 标记而不是裸 0。
    const sol = readAgentRuntimeTokenUsageDetail({
      rootDir,
      now: NOW,
      range: "today",
      member: { kind: "agent", agentId: "sol" },
      entityLabel: () => null,
      cut: CUT,
      projection: EMPTY_PROJECTION,
    });
    assert.equal(sol.sessions[0]!.usage, "unavailable");
    assert.equal(sol.totals.usageUnavailableDispatches, 1);
    assert.equal(sol.totals.totalTokens, 0);
    // squad 详情走实体投影取名。
    const squad = readAgentRuntimeTokenUsageDetail({
      rootDir,
      now: NOW,
      range: "today",
      member: { kind: "squad", squadId: "core-squad" },
      entityLabel: (squadId) => (squadId === "core-squad" ? "Core" : null),
      cut: CUT,
      projection: EMPTY_PROJECTION,
    });
    assert.deepEqual(squad.member, { kind: "squad", squadId: "core-squad", squadName: "Core" });
    assert.equal(squad.totals.sessionCount, 2);
    assert.deepEqual(squad.sessions.map(({ dispatchId }) => dispatchId).sort(), [
      "dispatch_00000000000000000000aa01",
      "dispatch_00000000000000000000aa04",
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("validateAgentRuntimeTokenUsage accepts the aggregate and rejects corrupted rows", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-validate-"));
  try {
    seedToday(rootDir);
    const result = read(rootDir);
    assert.deepEqual(validateAgentRuntimeTokenUsage(result), []);
    assert.equal(serializeAgentRuntimeTokenUsage(result), `${JSON.stringify(result)}\n`);
    assert.deepEqual(validateAgentRuntimeTokenUsage({ ...result, ok: false }), [
      "agent runtime token usage is invalid",
    ]);
    assert.deepEqual(
      validateAgentRuntimeTokenUsage({ ...result, agents: [{ ...result.agents[0]!, inputTokens: -1 }] }),
      ["agent runtime token usage is invalid"],
    );
    assert.deepEqual(validateAgentRuntimeTokenUsage({ ...result, agents: [{ ...result.agents[0]!, extra: 1 }] }), [
      "agent runtime token usage is invalid",
    ]);
    const detail = readAgentRuntimeTokenUsageDetail({
      rootDir,
      now: NOW,
      range: "today",
      member: { kind: "agent", agentId: "terra" },
      entityLabel: () => null,
      cut: CUT,
      projection: EMPTY_PROJECTION,
    });
    assert.deepEqual(validateAgentRuntimeTokenUsageDetail(detail), []);
    assert.equal(serializeAgentRuntimeTokenUsageDetail(detail), `${JSON.stringify(detail)}\n`);
    assert.deepEqual(
      validateAgentRuntimeTokenUsageDetail({
        ...detail,
        sessions: [{ ...detail.sessions[0]!, usage: "maybe" }],
      }),
      ["agent runtime token usage detail is invalid"],
    );
    assert.deepEqual(validateAgentRuntimeTokenUsageDetail({ ...detail, member: { kind: "squad" } }), [
      "agent runtime token usage detail is invalid",
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("repo.agentRuntime.tokenUsage and tokenUsageDetail are registered through the GUI read directory", () => {
  const facet = daemonGuiReadMethods.find(({ method }) => method === "repo.agentRuntime.tokenUsage");
  assert.ok(facet, "repo.agentRuntime.tokenUsage must be in the GUI read directory");
  assert.equal(facet.inputSchemaId, "gui.agent-runtime-token-usage/v1");
  assert.equal(facet.requiresRepo, true);
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.agentRuntime.tokenUsage",
      params: { repo: { repoId: "canonical" }, payload: {} },
    }),
    [],
  );
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.agentRuntime.tokenUsage",
      params: { repo: { repoId: "canonical" }, payload: { range: "7d" } },
    }),
    [],
  );
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.agentRuntime.tokenUsage",
      params: { repo: { repoId: "canonical" }, payload: { range: "yesterday" } },
    }),
    ["params.payload.range must be one of today, 7d, 30d"],
  );
  const detailFacet = daemonGuiReadMethods.find(({ method }) => method === "repo.agentRuntime.tokenUsageDetail");
  assert.ok(detailFacet, "repo.agentRuntime.tokenUsageDetail must be in the GUI read directory");
  assert.equal(detailFacet.inputSchemaId, "gui.agent-runtime-token-usage-detail/v1");
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.agentRuntime.tokenUsageDetail",
      params: { repo: { repoId: "canonical" }, payload: { range: "30d", agentId: "terra" } },
    }),
    [],
  );
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.agentRuntime.tokenUsageDetail",
      params: {
        repo: { repoId: "canonical" },
        payload: { agentId: "terra", squadId: "core-squad" },
      },
    }),
    [],
  );
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.agentRuntime.tokenUsageDetail",
      params: { repo: { repoId: "canonical" }, payload: { member: "terra" } },
    }),
    ['params.payload contains an unknown field "member"; allowed fields: "range", "agentId", "squadId".'],
  );
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-rpc-"));
  try {
    seedToday(rootDir);
    const parsed = parseDaemonGuiReadResult("repo.agentRuntime.tokenUsage", read(rootDir));
    assert.equal(parsed.ok, true);
    const parsedDetail = parseDaemonGuiReadResult(
      "repo.agentRuntime.tokenUsageDetail",
      readAgentRuntimeTokenUsageDetail({
        rootDir,
        now: NOW,
        range: "today",
        member: { kind: "agent", agentId: "terra" },
        entityLabel: () => null,
        cut: CUT,
        projection: EMPTY_PROJECTION,
      }),
    );
    assert.equal(parsedDetail.ok, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/** 一条带完整生命周期的派工:归因、用量、进程退出与归类都在流里,和 production 写入同构。 */
function seedDispatch(
  rootDir: string,
  index: number,
  options: {
    readonly startedAt?: string;
    readonly session?: string;
    readonly agentId?: string;
    readonly agentName?: string;
    readonly model?: string;
    readonly taskId?: string | null;
    readonly kindId?: string;
    readonly instanceId?: string;
    readonly tokens?: readonly [input: number, output: number, tools: number];
    readonly usageUnavailable?: boolean;
    readonly exit?: { readonly code: number | null; readonly afterMs: number };
    readonly classification?: "provider_fault" | "provider_quota" | "worker_stop" | "gate_red";
  },
): void {
  const dispatchId = `dispatch_${(0xc000 + index).toString(16).padStart(24, "0")}`,
    startedAt = options.startedAt ?? NOW;
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: options.taskId === undefined ? "task-a" : options.taskId,
    executionId: null,
    runtimeSessionId: options.session ?? `runtime-${index}`,
    instanceId: options.instanceId ?? "instance-codex",
    startedAt,
    ...(options.agentId ? { agentId: options.agentId, agentName: options.agentName ?? options.agentId } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.kindId ? { kindId: options.kindId } : {}),
  });
  if (options.exit) {
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 100 + index });
    if (options.classification)
      appendRuntimeWorkerRecord(rootDir, dispatchId, {
        kind: "attempt_outcome",
        classification: options.classification,
        reason: "fixture",
        provider: { instance: options.instanceId ?? "instance-codex", kind: options.kindId ?? "codex" },
        attemptGroupId: dispatchId,
        attemptIndex: 0,
      });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "process_exit",
      occurredAt: new Date(Date.parse(startedAt) + options.exit.afterMs).toISOString(),
      exitCode: options.exit.code,
      signal: options.exit.code === null ? "SIGTERM" : null,
    });
  }
  if (options.tokens) {
    const [input, output, tools] = options.tokens;
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "runtime_metrics",
      inputTokens: input,
      cacheReadTokens: 0,
      outputTokens: output,
      totalTokens: input + output,
      toolCallCount: tools,
      compacted: false,
      raw: {},
      ...(options.usageUnavailable ? { usageUnavailable: true } : {}),
    });
  }
}

/** 本地日历上往前 `days` 天的同一时刻:与读面的窗口规划同一种算法(不是固定毫秒数)。 */
function daysBefore(now: string, days: number, hours = 0): string {
  const at = new Date(now);
  at.setDate(at.getDate() - days);
  at.setHours(at.getHours() + hours);
  return at.toISOString();
}

function seedAnalysis(rootDir: string): void {
  // terra:两个成功会话(其中一个会话跨两次派工:第一次 provider 出错,续跑成功),一个因额度失败的会话。
  seedDispatch(rootDir, 1, {
    session: "s-terra-1",
    agentId: "terra",
    agentName: "Terra",
    model: "gpt-test",
    taskId: "task-a",
    tokens: [5_000, 1_000, 4],
    exit: { code: 1, afterMs: 60_000 },
    classification: "provider_fault",
  });
  seedDispatch(rootDir, 2, {
    session: "s-terra-1",
    startedAt: new Date(Date.parse(NOW) + 1_000).toISOString(),
    agentId: "terra",
    agentName: "Terra",
    model: "gpt-test",
    taskId: "task-a",
    tokens: [2_000, 2_000, 2],
    exit: { code: 0, afterMs: 120_000 },
  });
  seedDispatch(rootDir, 3, {
    session: "s-terra-2",
    agentId: "terra",
    agentName: "Terra",
    model: "gpt-test",
    taskId: "task-b",
    tokens: [400_000, 100_000, 30],
    exit: { code: 0, afterMs: 600_000 },
  });
  seedDispatch(rootDir, 4, {
    session: "s-terra-3",
    agentId: "terra",
    agentName: "Terra",
    model: "gpt-test",
    taskId: "task-b",
    tokens: [50_000, 0, 1],
    exit: { code: 1, afterMs: 30_000 },
    classification: "provider_quota",
  });
  // sol:一个被信号终止的会话(有用量),一个 provider 不上报用量的成功会话。
  seedDispatch(rootDir, 5, {
    session: "s-sol-1",
    agentId: "sol",
    agentName: "Sol",
    model: "opus-test",
    taskId: "task-solo",
    tokens: [20_000_000, 5_000_000, 90],
    exit: { code: null, afterMs: 3_600_000 },
  });
  seedDispatch(rootDir, 6, {
    session: "s-sol-2",
    agentId: "sol",
    agentName: "Sol",
    model: "opus-test",
    taskId: "task-solo",
    kindId: "claude",
    instanceId: "claude-main",
    tokens: [0, 0, 3],
    usageUnavailable: true,
    exit: { code: 0, afterMs: 10_000 },
  });
  // 无 agent、无任务、仍在跑的派工:进总量与会话统计,不进任务与成员视图。
  seedDispatch(rootDir, 7, { session: "s-direct", taskId: null, tokens: [300, 0, 0] });
  // 上一个同长周期(昨天零点到昨天的此刻)里的一条,和落在昨天此刻之后、两个周期都不算的一条。
  seedDispatch(rootDir, 8, { session: "s-prev", startedAt: daysBefore(NOW, 1, -1), tokens: [700, 300, 5] });
  seedDispatch(rootDir, 9, { session: "s-gap", startedAt: daysBefore(NOW, 1, 1), tokens: [9_000_000, 0, 0] });
}

test("the aggregate answers who spent, on what, how sessions ended and what the last period cost", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-analysis-"));
  try {
    seedAnalysis(rootDir);
    const result = read(rootDir);
    assert.deepEqual(validateAgentRuntimeTokenUsage(result), []);
    assert.equal(result.totals.totalTokens, 25_560_300);
    assert.equal(result.totals.sessionCount, 6);
    // 上一周期:只有昨天零点到昨天此刻之间的那一条。
    assert.equal(result.previous.totals.totalTokens, 1_000);
    assert.equal(result.previous.totals.sessionCount, 1);
    assert.equal(result.previous.until, daysBefore(NOW, 1));
    assert.equal(Date.parse(result.since) - Date.parse(result.previous.since), 86_400_000);
    // 按模型:同一组计数加会话结果。
    assert.deepEqual(
      result.models.map(({ model, totalTokens, sessionCount, succeededSessions, failedSessions, abortedSessions }) => [
        model,
        totalTokens,
        sessionCount,
        succeededSessions,
        failedSessions,
        abortedSessions,
      ]),
      [
        ["opus-test", 25_000_000, 2, 1, 0, 1],
        ["gpt-test", 560_000, 3, 2, 1, 0],
      ],
    );
    // 每个 worker 的成功/失败/中止会话数:跨两次派工的会话只算一个,结果取最后一次派工。
    const terra = result.agents.find(({ agentId }) => agentId === "terra")!,
      sol = result.agents.find(({ agentId }) => agentId === "sol")!;
    assert.deepEqual(
      [terra.sessionCount, terra.succeededSessions, terra.failedSessions, terra.abortedSessions],
      [3, 2, 1, 0],
    );
    assert.deepEqual([sol.sessionCount, sol.succeededSessions, sol.failedSessions, sol.abortedSessions], [2, 1, 0, 1]);
    // 花在什么事上:任务带标题与所属工作;不在索引里的任务不会出现在工作行。
    assert.deepEqual(result.tasks, [
      {
        taskId: "task-solo",
        title: "独立小改",
        workId: "task-solo",
        workTitle: "独立小改",
        sessionCount: 2,
        totalTokens: 25_000_000,
        costUsd: 0,
      },
      {
        taskId: "task-b",
        title: "补回归测试",
        workId: "work-root",
        workTitle: "发布线",
        sessionCount: 2,
        totalTokens: 550_000,
        costUsd: 0,
      },
      {
        taskId: "task-a",
        title: "接入读面",
        workId: "work-root",
        workTitle: "发布线",
        sessionCount: 1,
        totalTokens: 10_000,
        costUsd: 0,
      },
    ]);
    assert.deepEqual(result.works, [
      { workId: "task-solo", title: "独立小改", taskCount: 1, sessionCount: 2, totalTokens: 25_000_000, costUsd: 0 },
      { workId: "work-root", title: "发布线", taskCount: 2, sessionCount: 3, totalTokens: 560_000, costUsd: 0 },
    ]);
    // 按结果分的用量:失败与中止的会话花掉的就是「白花」的部分。
    assert.deepEqual(result.outcomes, [
      { outcome: "succeeded", sessionCount: 3, totalTokens: 510_000 },
      { outcome: "failed", sessionCount: 1, totalTokens: 50_000 },
      { outcome: "aborted", sessionCount: 1, totalTokens: 25_000_000 },
      { outcome: "running", sessionCount: 0, totalTokens: 0 },
      { outcome: "unknown", sessionCount: 1, totalTokens: 300 },
    ]);
    // 会话级统计只看上报了用量的 5 个会话:300 / 10K / 50K / 500K / 25M。
    const stats = result.sessions;
    assert.deepEqual(
      [stats.reportedSessions, stats.averageTokens, stats.medianTokens, stats.p90Tokens, stats.maxTokens],
      [5, 5_112_060, 50_000, 25_000_000, 25_000_000],
    );
    // 已结束的 5 个会话:180s(60+120)、600s、30s、3600s、10s。
    assert.deepEqual([stats.timedSessions, stats.averageDurationMs], [5, 884_000]);
    assert.equal(stats.averageToolCalls, Math.round(130 / 6));
    assert.deepEqual(
      stats.distribution.map(({ ceiling, sessionCount, totalTokens }) => [ceiling, sessionCount, totalTokens]),
      [
        [10_000, 1, 300],
        [100_000, 2, 60_000],
        [1_000_000, 1, 500_000],
        [10_000_000, 0, 0],
        [100_000_000, 1, 25_000_000],
        [null, 0, 0],
      ],
    );
    assert.deepEqual(
      stats.distribution.map(({ ceiling }) => ceiling),
      tokenUsageSessionBinCeilings,
    );
    assert.deepEqual(stats.top[0], {
      runtimeSessionId: "s-sol-1",
      agentId: "sol",
      agentName: "Sol",
      taskId: "task-solo",
      taskTitle: "独立小改",
      model: "opus-test",
      startedAt: NOW,
      durationMs: 3_600_000,
      outcome: "aborted",
      totalTokens: 25_000_000,
      toolCallCount: 90,
    });
    assert.deepEqual(
      stats.top.map(({ runtimeSessionId }) => runtimeSessionId),
      ["s-sol-1", "s-terra-2", "s-terra-3", "s-terra-1", "s-direct"],
      "sessions without consumption are not listed as the largest",
    );
    // 趋势分系列:每个系列与桶一一对齐,各系列之和等于桶的总量。
    for (const series of [result.trend.agents, result.trend.models]) {
      assert.ok(series.every(({ totalTokens }) => totalTokens.length === result.buckets.length));
      result.buckets.forEach((bucket, index) =>
        assert.equal(
          series.reduce((total, row) => total + row.totalTokens[index]!, 0),
          bucket.totalTokens,
        ),
      );
    }
    assert.deepEqual(
      result.trend.agents.map(({ key, name }) => [key, name]),
      [
        ["sol", "Sol"],
        ["terra", "Terra"],
        [null, ""],
      ],
      "dispatches without an agent fold into the unnamed series",
    );
    // 未上报用量的派工按 provider 归类。
    assert.deepEqual(result.unreported, [{ kindId: "claude", instanceId: "claude-main", dispatchCount: 1 }]);
    assert.equal(result.totals.usageUnavailableDispatches, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("every analysis group is capped and the trend folds the tail into one series", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-caps-"));
  try {
    const count = 14;
    for (let index = 0; index < count; index += 1)
      seedDispatch(rootDir, index, {
        agentId: `agent-${String(index).padStart(2, "0")}`,
        model: `model-${String(index).padStart(2, "0")}`,
        taskId: `task-${String(index).padStart(2, "0")}`,
        tokens: [1_000 * (index + 1), 0, 0],
      });
    for (let index = 0; index < count; index += 1)
      seedDispatch(rootDir, 100 + index, {
        kindId: "zcode",
        instanceId: `instance-${String(index).padStart(2, "0")}`,
        taskId: null,
        tokens: [0, 0, 0],
        usageUnavailable: true,
        exit: { code: 0, afterMs: 1_000 },
      });
    const result = readAgentRuntimeTokenUsage({
      rootDir,
      now: NOW,
      range: "today",
      entityLabel: () => null,
      // 每个任务自成一个工作:工作行也超过上限。
      taskOf: (taskId) => ({ taskId, title: `T ${taskId}`, taskClass: "task", parentTaskId: null }),
      cut: CUT,
      projection: EMPTY_PROJECTION,
    });
    assert.deepEqual(validateAgentRuntimeTokenUsage(result), []);
    assert.equal(result.agents.length, count, "member rows stay complete: the ranking pages them itself");
    assert.equal(result.models.length, tokenUsageInsightLimits.models);
    assert.equal(result.models[0]?.model, "model-13", "the cap keeps the largest rows");
    assert.equal(result.tasks.length, tokenUsageInsightLimits.tasks);
    assert.equal(result.tasks[0]?.taskId, "task-13");
    assert.equal(result.works.length, tokenUsageInsightLimits.works);
    assert.equal(result.sessions.top.length, tokenUsageInsightLimits.topSessions);
    assert.equal(result.unreported.length, tokenUsageInsightLimits.unreportedProviders);
    assert.equal(result.totals.usageUnavailableDispatches, count, "the total still counts every provider");
    // 具名系列到上限为止,再加 1 个合并系列;合并系列装下其后的全部。
    assert.equal(result.trend.agents.length, tokenUsageInsightLimits.trendSeries + 1);
    const rest = result.trend.agents.at(-1)!;
    assert.equal(rest.key, null);
    assert.equal(
      rest.totalTokens.reduce((total, value) => total + value, 0),
      Array.from({ length: count - tokenUsageInsightLimits.trendSeries }, (_, rank) => (rank + 1) * 1_000).reduce(
        (total, value) => total + value,
        0,
      ),
    );
    assert.equal(
      result.trend.agents.reduce((total, row) => total + row.totalTokens.reduce((sum, value) => sum + value, 0), 0),
      result.totals.totalTokens,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("an empty window yields zeroed, valid analysis groups", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-empty-"));
  try {
    const result = read(rootDir);
    assert.deepEqual(validateAgentRuntimeTokenUsage(result), []);
    assert.equal(result.totals.totalTokens, 0);
    assert.equal(result.previous.totals.totalTokens, 0);
    assert.deepEqual(
      [result.models, result.tasks, result.works, result.unreported, result.trend.agents, result.trend.models],
      [[], [], [], [], [], []],
    );
    assert.deepEqual(result.sessions, {
      reportedSessions: 0,
      averageTokens: 0,
      medianTokens: 0,
      p90Tokens: 0,
      maxTokens: 0,
      averageDurationMs: null,
      timedSessions: 0,
      averageToolCalls: 0,
      distribution: tokenUsageSessionBinCeilings.map((ceiling) => ({ ceiling, sessionCount: 0, totalTokens: 0 })),
      top: [],
    });
    assert.ok(result.outcomes.every(({ sessionCount, totalTokens }) => sessionCount === 0 && totalTokens === 0));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("validateAgentRuntimeTokenUsage rejects analysis groups outside their shape or bounds", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-validate-analysis-"));
  try {
    seedAnalysis(rootDir);
    const result = read(rootDir),
      invalid = ["agent runtime token usage is invalid"],
      corrupted: readonly [string, Record<string, unknown>][] = [
        ["a missing previous period", { previous: undefined }],
        ["a previous period without its end", { previous: { since: result.previous.since, totals: result.totals } }],
        ["a model row without session outcomes", { models: [{ model: "m", ...result.totals }] }],
        [
          "more model rows than the cap",
          { models: Array.from({ length: tokenUsageInsightLimits.models + 1 }, () => result.models[0]) },
        ],
        [
          "more task rows than the cap",
          { tasks: Array.from({ length: tokenUsageInsightLimits.tasks + 1 }, () => result.tasks[0]) },
        ],
        ["a task row without a title", { tasks: [{ ...result.tasks[0]!, title: "" }] }],
        ["a work row with a negative count", { works: [{ ...result.works[0]!, taskCount: -1 }] }],
        ["outcome rows out of the declared order", { outcomes: [...result.outcomes].reverse() }],
        ["an unknown outcome word", { outcomes: result.outcomes.map((row) => ({ ...row, outcome: "cancelled" })) }],
        [
          "a distribution with a missing bin",
          { sessions: { ...result.sessions, distribution: result.sessions.distribution.slice(1) } },
        ],
        ["a fractional average", { sessions: { ...result.sessions, averageTokens: 1.5 } }],
        [
          "a top session with an unknown outcome",
          { sessions: { ...result.sessions, top: [{ ...result.sessions.top[0]!, outcome: "done" }] } },
        ],
        [
          "a trend series shorter than the bucket ladder",
          { trend: { ...result.trend, agents: [{ key: "terra", name: "Terra", totalTokens: [1] }] } },
        ],
        [
          "a named trend series without a name",
          {
            trend: {
              ...result.trend,
              models: [{ key: "gpt-test", name: "", totalTokens: result.buckets.map(() => 0) }],
            },
          },
        ],
        ["an unreported provider without an instance", { unreported: [{ kindId: "claude", dispatchCount: 1 }] }],
      ];
    for (const [label, patch] of corrupted)
      assert.deepEqual(validateAgentRuntimeTokenUsage({ ...result, ...patch }), invalid, label);
    assert.deepEqual(
      parseDaemonGuiReadResult("repo.agentRuntime.tokenUsage", result).ok,
      true,
      "the unmodified aggregate passes the GUI read result gate",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a signal-terminated dispatch is reported as aborted in the member detail", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-aborted-"));
  try {
    seedAnalysis(rootDir);
    const detail = readAgentRuntimeTokenUsageDetail({
      rootDir,
      now: NOW,
      range: "today",
      member: { kind: "agent", agentId: "sol" },
      entityLabel: () => null,
      cut: CUT,
      projection: EMPTY_PROJECTION,
    });
    assert.deepEqual(validateAgentRuntimeTokenUsageDetail(detail), []);
    assert.deepEqual(detail.sessions.map(({ outcome }) => outcome).sort(), ["aborted", "succeeded"]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

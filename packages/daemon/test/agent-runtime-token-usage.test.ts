// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import {
  agentRuntimeTokenUsageRanges,
  readAgentRuntimeTokenUsage,
  readAgentRuntimeTokenUsageDetail,
  serializeAgentRuntimeTokenUsage,
  serializeAgentRuntimeTokenUsageDetail,
  validateAgentRuntimeTokenUsage,
  validateAgentRuntimeTokenUsageDetail,
} from "../src/agent-runtime-token-usage.ts";
import { daemonGuiReadMethods, validateDaemonRpcCall } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";

const NOW = "2026-09-14T12:00:00.000Z",
  CUT = { status: "ready" as const, watermark: 7, sourceRevision: 7 };

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
    cut: CUT,
  });
}

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
      }),
    );
    assert.equal(parsedDetail.ok, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

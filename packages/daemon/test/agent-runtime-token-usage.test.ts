// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import {
  readAgentRuntimeTokenUsage,
  serializeAgentRuntimeTokenUsage,
  validateAgentRuntimeTokenUsage,
} from "../src/agent-runtime-token-usage.ts";
import { daemonGuiReadMethods, validateDaemonRpcCall } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";

const NOW = "2026-09-14T12:00:00.000Z",
  CUT = { status: "ready" as const, watermark: 7, sourceRevision: 7 };

function metrics(input: number, cache: number, output: number, tools: number) {
  return {
    kind: "runtime_metrics",
    inputTokens: input,
    cacheReadTokens: cache,
    outputTokens: output,
    totalTokens: input + cache + output,
    toolCallCount: tools,
    compacted: false,
    raw: { input_tokens: input, output_tokens: output },
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
  // 无 metrics 的派工:会话仍计数,token 为零。
  openDispatchStream(rootDir, {
    dispatchId: "dispatch_00000000000000000000aa03",
    taskId: "task-tokens",
    executionId: "execution-2",
    runtimeSessionId: "runtime-sol",
    instanceId: "instance-codex",
    startedAt: NOW,
    agentId: "sol",
    agentName: "Sol",
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
  // 两天前的派工:不在「今天」窗口。
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

test("readAgentRuntimeTokenUsage aggregates today per agent and squad from dispatch streams", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-"));
  try {
    seedToday(rootDir);
    const result = readAgentRuntimeTokenUsage({
      rootDir,
      now: NOW,
      entityLabel: (squadId) => (squadId === "core-squad" ? "Core" : null),
      cut: CUT,
    });
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
      },
      {
        agentId: "sol",
        agentName: "Sol",
        sessionCount: 1,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        toolCallCount: 0,
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
      },
    ]);
    assert.equal(result.status, "ready");
    assert.equal(result.watermark, 7);
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
    const result = readAgentRuntimeTokenUsage({ rootDir, now: NOW, entityLabel: () => null, cut: CUT });
    assert.deepEqual(
      result.agents.map(({ agentId }) => agentId),
      ["big", "mid", "small"],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("validateAgentRuntimeTokenUsage accepts the aggregate and rejects corrupted rows", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-validate-"));
  try {
    seedToday(rootDir);
    const result = readAgentRuntimeTokenUsage({ rootDir, now: NOW, entityLabel: () => null, cut: CUT });
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
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("repo.agentRuntime.tokenUsage is registered through the GUI read directory", () => {
  const facet = daemonGuiReadMethods.find(({ method }) => method === "repo.agentRuntime.tokenUsage");
  assert.ok(facet, "repo.agentRuntime.tokenUsage must be in the GUI read directory");
  assert.equal(facet.inputSchemaId, "gui.empty/v1");
  assert.equal(facet.requiresRepo, true);
  assert.deepEqual(
    validateDaemonRpcCall({ method: "repo.agentRuntime.tokenUsage", params: { repo: { repoId: "canonical" } } }),
    [],
  );
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.agentRuntime.tokenUsage",
      params: { repo: { repoId: "canonical" }, payload: { since: NOW } },
    }),
    ['params contains an unknown field "payload"; allowed fields: "repo".'],
  );
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-usage-rpc-"));
  try {
    seedToday(rootDir);
    const parsed = parseDaemonGuiReadResult(
      "repo.agentRuntime.tokenUsage",
      readAgentRuntimeTokenUsage({ rootDir, now: NOW, entityLabel: () => null, cut: CUT }),
    );
    assert.equal(parsed.ok, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

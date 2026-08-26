// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeEventV1, RuntimeSession, TaskProjection } from "../../kernel/src/index.ts";
import {
  serializeAgentRuntimeSessionGroups,
  validateAgentRuntimeSessionGroups,
} from "../src/agent-runtime-contract.ts";
import { makeAgentRuntimeReadModel } from "../src/agent-runtime-read.ts";
import {
  daemonGuiReadMethods,
  validateDaemonRpcCall,
  type TaskDispatchRow,
} from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";

test("session group facet is contracted and validates bounded daemon-side filters", () => {
  const facet = daemonGuiReadMethods.find(({ method }) => method === "repo.agentRuntime.sessionGroups");
  assert.deepEqual(
    facet && {
      phase: facet.phase,
      method: facet.method,
      serviceMethod: facet.serviceMethod,
      outputSchemaId: facet.outputSchemaId,
    },
    {
      phase: "Runtime-B",
      method: "repo.agentRuntime.sessionGroups",
      serviceMethod: "readAgentRuntimeSessionGroups",
      outputSchemaId: "daemon.agent-runtime-session-groups/v1",
    },
  );
  const call = (payload: Readonly<Record<string, unknown>>) =>
    validateDaemonRpcCall({
      method: "repo.agentRuntime.sessionGroups",
      params: { repo: { repoId: "runtime-groups" }, payload },
    });
  assert.deepEqual(call({}), []);
  assert.deepEqual(
    call({ groupBy: "squad", since: "2026-08-25T00:00:00.000Z", query: "terra", agentId: "sol", limit: 20 }),
    [],
  );
  assert.deepEqual(call({ groupBy: "agent", squadId: "core-squad" }), []);
  assert.notDeepEqual(call({ groupBy: "worker" }), []);
  assert.notDeepEqual(call({ since: "yesterday" }), []);
  assert.notDeepEqual(call({ limit: 1_001 }), []);
  assert.notDeepEqual(call({ cursor: "not-in-v1" }), []);
  assert.notDeepEqual(call({ agentId: "" }), []);
  assert.notDeepEqual(call({ squadId: 7 }), []);
});

test("session groups default to active plus 24h and group/filter/limit before returning exact totals", () => {
  const dispatchReads: string[][] = [];
  const projection = projectionFixture(),
    reads = makeAgentRuntimeReadModel({
      projection,
      store: {} as never,
      stream: {} as never,
      now: () => "2026-08-26T12:00:00.000Z",
      readDispatches: ({ sessions: selected }) => {
        const taskIds = [...new Set(selected.flatMap((session) => session.taskBindings.map(({ taskId }) => taskId)))];
        dispatchReads.push(taskIds);
        return dispatches.filter(({ taskId }) => taskIds.includes(taskId));
      },
    }),
    defaultResult = parseDaemonGuiReadResult("repo.agentRuntime.sessionGroups", reads.sessionGroups({}));
  assert.deepEqual(
    defaultResult.groups.map(({ key }) => key),
    ["task-c", "task-a", "unattributed"],
  );
  assert.deepEqual(defaultResult.totals, { groups: 3, sessions: 3 });
  assert.equal(
    defaultResult.groups.some(({ key }) => key === "task-b"),
    false,
  );
  assert.equal(defaultResult.groups.find(({ key }) => key === "task-a")?.label, "Task Alpha");
  assert.equal(defaultResult.groups.find(({ key }) => key === "task-a")?.roundCount, 1);

  const searched = reads.sessionGroups({ groupBy: "agent", query: "dispatch-a sol succeeded" });
  assert.deepEqual(
    searched.groups.map(({ key, label }) => ({ key, label })),
    [{ key: "sol", label: "Sol" }],
  );
  assert.deepEqual(searched.totals, { groups: 1, sessions: 1 });

  const all = reads.sessionGroups({ since: "2026-08-01T00:00:00.000Z", limit: 1 });
  assert.equal(all.groups.length, 1);
  assert.deepEqual(all.totals, { groups: 4, sessions: 4 });
  assert.equal(all.truncated, true);
  assert.deepEqual(dispatchReads, [
    ["task-a", "task-c"],
    ["task-a", "task-c"],
    ["task-a", "task-b", "task-c"],
  ]);
});

test("session groups filter members by exact agent/squad attribution, not substring", () => {
  const reads = makeAgentRuntimeReadModel({
    projection: projectionFixture(),
    store: {} as never,
    stream: {} as never,
    now: () => "2026-08-26T12:00:00.000Z",
    readDispatches: ({ sessions: selected }) => {
      const taskIds = new Set(selected.flatMap((session) => session.taskBindings.map(({ taskId }) => taskId)));
      return dispatches.filter(({ taskId }) => taskIds.has(taskId));
    },
  });
  // agentId=sol:只有 dispatch-a(sol)归属的 task-a/runtime-a;terra/luna/direct 会话
  // 与任务组全部排除——即使别的实例名/文本里包含 "sol" 子串也不命中。
  const solTasks = reads.sessionGroups({ groupBy: "task", agentId: "sol" });
  assert.deepEqual(
    solTasks.groups.map(({ key, sessionCount, roundCount }) => ({ key, sessionCount, roundCount })),
    [{ key: "task-a", sessionCount: 1, roundCount: 1 }],
  );
  assert.deepEqual(solTasks.totals, { groups: 1, sessions: 1 });
  // 未命中任何派工的 agent:空结果,不是子串兜底。
  const unknownAgent = reads.sessionGroups({ groupBy: "task", agentId: "instance-sol-runner" });
  assert.deepEqual(unknownAgent.groups, []);
  assert.deepEqual(unknownAgent.totals, { groups: 0, sessions: 0 });
  // squadId=core-squad:只有 dispatch-a 带 squadId;groupBy=agent 时 sol 是唯一归属。
  const coreSquad = reads.sessionGroups({ groupBy: "agent", squadId: "core-squad" });
  assert.deepEqual(
    coreSquad.groups.map(({ key, sessionCount }) => ({ key, sessionCount })),
    [{ key: "sol", sessionCount: 1 }],
  );
  // 组合 groupBy=squad + squadId:单组 core-squad,unattributed 桶消失。
  const squadGroups = reads.sessionGroups({ groupBy: "squad", squadId: "core-squad" });
  assert.deepEqual(
    squadGroups.groups.map(({ key }) => key),
    ["core-squad"],
  );
  // 无派工行的 direct 会话在任何精确过滤下都不归属(no dispatch = no attribution)。
  const directAgent = reads.sessionGroups({ groupBy: "task", agentId: "luna" });
  assert.deepEqual(
    directAgent.groups.map(({ key }) => key),
    ["task-c"],
  );
});

test("session group results reject secret-bearing or identity-incoherent output", () => {
  const result = makeAgentRuntimeReadModel({
    projection: projectionFixture(),
    store: {} as never,
    stream: {} as never,
    now: () => "2026-08-26T12:00:00.000Z",
    readDispatches: ({ sessions: selected }) => {
      const taskIds = new Set(selected.flatMap((session) => session.taskBindings.map(({ taskId }) => taskId)));
      return dispatches.filter(({ taskId }) => taskIds.has(taskId));
    },
  }).sessionGroups({ groupBy: "squad" });
  assert.deepEqual(validateAgentRuntimeSessionGroups(result), []);
  assert.equal(serializeAgentRuntimeSessionGroups(result), `${JSON.stringify(result)}\n`);
  assert.notDeepEqual(validateAgentRuntimeSessionGroups({ ...result, token: "secret" }), []);
  assert.notDeepEqual(
    validateAgentRuntimeSessionGroups({
      ...result,
      groups: result.groups.map((group) => ({ ...group, taskId: "not-valid-for-squad" })),
    }),
    [],
  );
});

const sessions: readonly RuntimeSession[] = [
  runtimeSession("runtime-a", "instance-a", "2026-08-26T11:00:00.000Z", "exited", "succeeded", ["task-a"]),
  runtimeSession("runtime-b", "instance-b", "2026-08-20T11:00:00.000Z", "exited", "failed", ["task-b"]),
  runtimeSession("runtime-c", "instance-c", "2026-08-20T10:00:00.000Z", "live", null, ["task-c"]),
  runtimeSession("runtime-direct", "instance-direct", "2026-08-26T10:00:00.000Z", "exited", "cancelled", []),
];

const dispatches: readonly TaskDispatchRow[] = [
  dispatch("dispatch-a", "runtime-a", "task-a", "instance-a", "2026-08-26T10:30:00.000Z", "succeeded", {
    agentId: "sol",
    agentName: "Sol",
    squadId: "core-squad",
    delegatedByAgentId: "fable",
  }),
  dispatch("dispatch-b", "runtime-b", "task-b", "instance-b", "2026-08-20T10:30:00.000Z", "failed", {
    agentId: "terra",
    agentName: "Terra",
  }),
  dispatch("dispatch-c", "runtime-c", "task-c", "instance-c", "2026-08-20T09:30:00.000Z", "running", {
    agentId: "luna",
    agentName: "Luna",
  }),
];

function projectionFixture(): TaskProjection {
  const selected = () => sessions;
  return {
    readTaskStatuses: () => ({ status: "ready", rows: [], watermark: 40, sourceRevision: 40 }),
    readRuntimeSessions: selected,
    readRuntimeDispatches: () => sessions.map(runtimeDispatch),
    readTaskRuntimeBatch: ({ taskIds }: { readonly taskIds: readonly string[] }) => ({
      rows: taskIds.map((taskId) => ({
        taskId,
        title: taskId === "task-a" ? "Task Alpha" : taskId,
        packagePath: null,
        sessions: sessions.filter((session) => session.taskBindings.some((binding) => binding.taskId === taskId)),
      })),
    }),
    read: (taskId: string) => ({
      snapshot: { task: { title: taskId === "task-a" ? "Task Alpha" : taskId } },
    }),
    getEntity: (kind: string, id: string) => ({
      value: { name: kind === "squad" && id === "core-squad" ? "Core Squad" : id },
    }),
  } as unknown as TaskProjection;
}

function runtimeSession(
  runtimeSessionId: string,
  instanceId: string,
  lastObservedAt: string,
  liveness: RuntimeSession["liveness"],
  outcome: RuntimeSession["outcome"],
  taskIds: readonly string[],
): RuntimeSession {
  return {
    runtimeSessionId,
    instanceId,
    installationId: "codex-installation",
    kindId: "codex",
    definitionSnapshotRef: `artifact:definition/${runtimeSessionId}`,
    providerSessionId: null,
    transcriptRef: null,
    launchGeneration: 1,
    liveness,
    attachable: false,
    taskBindings: taskIds.map((taskId) => ({
      taskId,
      executionId: `execution-${taskId}`,
      providerSessionId: `provider-${runtimeSessionId}`,
      transcriptRef: `file:${runtimeSessionId}`,
      boundAt: lastObservedAt,
    })),
    outcome,
    exitCode: outcome === null ? null : 0,
    resultRef: null,
    lastObservedAt,
  };
}

function runtimeDispatch(
  session: RuntimeSession,
): Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }> {
  return {
    type: "runtime_dispatch_requested",
    occurredAt: session.lastObservedAt,
    payload: { runtimeSessionId: session.runtimeSessionId },
  } as Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>;
}

function dispatch(
  dispatchId: string,
  runtimeSessionId: string,
  taskId: string,
  instanceId: string,
  startedAt: string,
  status: TaskDispatchRow["status"],
  optional: Partial<TaskDispatchRow>,
): TaskDispatchRow {
  return {
    dispatchId,
    runtimeSessionId,
    taskId,
    executionId: `execution-${taskId}`,
    instanceId,
    providerSessionId: null,
    eventStreamRef: null,
    startedAt,
    endedAt: status === "running" ? null : startedAt,
    outcome: status === "running" || status === "lost" ? null : status,
    status,
    ...optional,
  };
}

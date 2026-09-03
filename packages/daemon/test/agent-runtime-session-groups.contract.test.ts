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
import { deriveUseCaseProjectionInputs } from "../../kernel/src/index.ts";
import type { AgentRuntimeSessionGroupsResult } from "../src/agent-runtime-contract.ts";

/** Parse a session-groups read the way the GUI now receives it: inside the projection envelope. */
function parseSessionGroupsProjection(projection: AgentRuntimeSessionGroupsResult): AgentRuntimeSessionGroupsResult {
  const envelope = parseDaemonGuiReadResult("repo.projection.read", {
    schema: "daemon.use-case-projection/v1",
    ok: true,
    name: "runtime-session-groups",
    facet: "groups",
    version: 1,
    inputs: deriveUseCaseProjectionInputs("runtime-session-groups"),
    projection,
  });
  return envelope.projection as AgentRuntimeSessionGroupsResult;
}

test("session groups are contracted as a use-case projection with bounded daemon-side filters", () => {
  // `repo.agentRuntime.sessionGroups` is replaced by the `runtime-session-groups` projection; the
  // bounded-filter contract below is unchanged, which is the point — CH4 moves the boundary, not
  // the field names.
  assert.equal(
    daemonGuiReadMethods.some(({ method }) => method === "repo.agentRuntime.sessionGroups"),
    false,
    "repo.agentRuntime.sessionGroups must no longer be a read method",
  );
  const facet = daemonGuiReadMethods.find(({ method }) => method === "repo.projection.read");
  assert.deepEqual(
    facet && {
      phase: facet.phase,
      method: facet.method,
      serviceMethod: facet.serviceMethod,
      outputSchemaId: facet.outputSchemaId,
    },
    {
      phase: "PLT-Ontology-4.1",
      method: "repo.projection.read",
      serviceMethod: "readUseCaseProjection",
      outputSchemaId: "daemon.use-case-projection/v1",
    },
  );
  const call = (payload: Readonly<Record<string, unknown>>) =>
    validateDaemonRpcCall({
      method: "repo.projection.read",
      params: { repo: { repoId: "runtime-groups" }, payload: { name: "runtime-session-groups", ...payload } },
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
  // 状态筛选是同一条读的一个入参,不是第二个读:传输层收数组、拒非数组。
  assert.deepEqual(call({ groupBy: "task", status: ["failed", "lost"] }), []);
  assert.notDeepEqual(call({ status: "failed" }), []);
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
    defaultResult = parseSessionGroupsProjection(reads.sessionGroups({}));
  assert.deepEqual(
    defaultResult.groups.map(({ key }) => key),
    ["task-c", "task-a", "unattributed:no-dispatch"],
  );
  assert.deepEqual(defaultResult.totals, { groups: 3, sessions: 3 });
  assert.equal(
    defaultResult.groups.some(({ key }) => key === "task-b"),
    false,
  );
  assert.equal(defaultResult.groups.find(({ key }) => key === "task-a")?.label, "Task Alpha");
  assert.equal(defaultResult.groups.find(({ key }) => key === "task-a")?.roundCount, 1);
  assert.deepEqual(
    defaultResult.groups.find(({ key }) => key === "task-a")?.latestRound && {
      classification: defaultResult.groups.find(({ key }) => key === "task-a")?.latestRound?.classification,
      reason: defaultResult.groups.find(({ key }) => key === "task-a")?.latestRound?.reason,
    },
    { classification: "worker_stop", reason: "Worker completed the attempt successfully." },
  );

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
    classification: "worker_stop",
    reason: "Worker completed the attempt successfully.",
  }),
  dispatch("dispatch-b", "runtime-b", "task-b", "instance-b", "2026-08-20T10:30:00.000Z", "failed", {
    agentId: "terra",
    agentName: "Terra",
    classification: "provider_fault",
    reason: "Provider rate limited the attempt (HTTP 429).",
  }),
  dispatch("dispatch-c", "runtime-c", "task-c", "instance-c", "2026-08-20T09:30:00.000Z", "running", {
    agentId: "luna",
    agentName: "Luna",
    classification: null,
    reason: null,
  }),
];

function projectionFixture(): TaskProjection {
  const selected = () => sessions;
  return {
    readCut: () => ({ status: "ready", watermark: 40, sourceRevision: 40 }),
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

/** 阴性对照:`timestamp()` 允许小数秒可选且位数不限,所以同一条流上会同时出现
 * `...:00Z` 与 `...:00.001Z`。字典序下 `"Z"(0x5A) > "."(0x2E)`,更早的那条会被判成更晚——
 * 取 max 与分组排序都必须按时间瞬值判定。 */
const mixedPrecisionSessions: readonly RuntimeSession[] = [
  runtimeSession("runtime-coarse", "instance-x", "2026-08-27T10:00:00Z", "exited", "succeeded", ["task-mixed"]),
  runtimeSession("runtime-fine", "instance-x", "2026-08-27T10:00:00.001Z", "exited", "succeeded", ["task-mixed"]),
  runtimeSession("runtime-other", "instance-y", "2026-08-27T09:00:00Z", "exited", "succeeded", ["task-other"]),
];

function mixedPrecisionProjection(): TaskProjection {
  return {
    readCut: () => ({ status: "ready", watermark: 1, sourceRevision: 1 }),
    readTaskStatuses: () => ({ status: "ready", rows: [], watermark: 1, sourceRevision: 1 }),
    readRuntimeSessions: () => mixedPrecisionSessions,
    readRuntimeDispatches: () => mixedPrecisionSessions.map(runtimeDispatch),
    readTaskRuntimeBatch: ({ taskIds }: { readonly taskIds: readonly string[] }) => ({
      rows: taskIds.map((taskId) => ({
        taskId,
        title: taskId,
        packagePath: null,
        sessions: mixedPrecisionSessions.filter((session) =>
          session.taskBindings.some((binding) => binding.taskId === taskId),
        ),
      })),
    }),
    read: (taskId: string) => ({ snapshot: { task: { title: taskId } } }),
    getEntity: (kind: string, id: string) => ({ value: { name: id } }),
  } as unknown as TaskProjection;
}

test("session-group activity is derived from time instants, so mixed ISO precision never inverts the order", () => {
  const reads = makeAgentRuntimeReadModel({
    projection: mixedPrecisionProjection(),
    store: {} as never,
    stream: {} as never,
    now: () => "2026-08-27T12:00:00.000Z",
    readDispatches: () => [],
  });
  const groups = reads.sessionGroups({ groupBy: "task", since: "2026-08-27T00:00:00.000Z" }).groups;
  const mixed = groups.find(({ key }) => key === "task-mixed");
  assert.equal(mixed?.latestActivityAt, "2026-08-27T10:00:00.001Z");
  // 排序键同样按瞬值:两个组的活动时间只差 1ms,字典序会把 09:00:00Z 的组排到前面。
  assert.deepEqual(
    groups.map(({ key }) => key),
    ["task-mixed", "task-other"],
  );
});

/** 状态筛选与桶命名共用的读模型:与上面几个用例同一份 fixture,只是不再重复注入样板。 */
function statusReads() {
  return makeAgentRuntimeReadModel({
    projection: projectionFixture(),
    store: {} as never,
    stream: {} as never,
    now: () => "2026-08-26T12:00:00.000Z",
    readDispatches: ({ sessions: selected }) => {
      const taskIds = new Set(selected.flatMap((session) => session.taskBindings.map(({ taskId }) => taskId)));
      return dispatches.filter(({ taskId }) => taskIds.has(taskId));
    },
  });
}

const SINCE_ALL = "2026-08-01T00:00:00.000Z";

test("session groups narrow by status on the daemon side, as a set, composed with every other filter", () => {
  const reads = statusReads(),
    unfiltered = reads.sessionGroups({ since: SINCE_ALL });
  assert.deepEqual(unfiltered.totals, { groups: 4, sessions: 4 });

  // 单状态:严格小于不过滤,且留下的组成员状态确实匹配。
  const failed = parseSessionGroupsProjection(reads.sessionGroups({ since: SINCE_ALL, status: ["failed"] }));
  assert.deepEqual(
    failed.groups.map(({ key, latestStatus, sessionCount }) => ({ key, latestStatus, sessionCount })),
    [{ key: "task-b", latestStatus: "failed", sessionCount: 1 }],
  );
  assert.deepEqual(failed.totals, { groups: 1, sessions: 1 });
  assert.equal(failed.totals.sessions < unfiltered.totals.sessions, true);

  // 集合语义:检索框的 token 是 AND,写不出「failed 或 running」;status 是 OR。
  assert.deepEqual(reads.sessionGroups({ since: SINCE_ALL, query: "failed running" }).totals, {
    groups: 0,
    sessions: 0,
  });
  const eitherOr = reads.sessionGroups({ since: SINCE_ALL, status: ["failed", "running"] });
  assert.deepEqual(eitherOr.groups.map(({ key }) => key).sort(), ["task-b", "task-c"]);
  assert.deepEqual(eitherOr.totals, { groups: 2, sessions: 2 });

  // 与 groupBy / query / agentId 组合:三个维度同时生效,不是任取其一。
  const combined = reads.sessionGroups({
    groupBy: "agent",
    since: SINCE_ALL,
    status: ["running"],
    query: "luna",
  });
  assert.deepEqual(
    combined.groups.map(({ key, sessionCount }) => ({ key, sessionCount })),
    [{ key: "luna", sessionCount: 1 }],
  );
  assert.deepEqual(reads.sessionGroups({ since: SINCE_ALL, status: ["running"], agentId: "sol" }).totals, {
    groups: 0,
    sessions: 0,
  });

  // truncated 跟着过滤后的集合走,不是过滤前的组数。
  const truncated = reads.sessionGroups({ since: SINCE_ALL, status: ["failed", "running"], limit: 1 });
  assert.equal(truncated.truncated, true);
  assert.deepEqual(truncated.totals, { groups: 2, sessions: 2 });
  assert.equal(reads.sessionGroups({ since: SINCE_ALL, status: ["failed"], limit: 1 }).truncated, false);

  // 非法取值报 invalid_request,不静默忽略;空数组同样被拒(发空集的调用方想收窄)。
  for (const status of [["nope"], [], "failed", ["failed", 7]])
    assert.throws(
      () => reads.sessionGroups({ since: SINCE_ALL, status }),
      (error: unknown) => (error as { code?: string }).code === "invalid_request",
      `status ${JSON.stringify(status)} must be rejected, not silently ignored`,
    );
});

test("status narrowing selects members, not the group's latestStatus", () => {
  // 同一个任务的两条会话:较新的成功、较早的失败。按组的 latestStatus 过滤会把整组滤掉;
  // 按成员过滤必须留下这个组,并且组头仍报它自己的 latestStatus。
  const mixed: readonly RuntimeSession[] = [
    runtimeSession("runtime-late", "instance-m", "2026-08-26T11:30:00.000Z", "exited", "succeeded", ["task-m"]),
    runtimeSession("runtime-early", "instance-m", "2026-08-26T10:30:00.000Z", "exited", "failed", ["task-m"]),
  ];
  const reads = makeAgentRuntimeReadModel({
    projection: {
      readCut: () => ({ status: "ready", watermark: 1, sourceRevision: 1 }),
      readTaskStatuses: () => ({ status: "ready", rows: [], watermark: 1, sourceRevision: 1 }),
      readRuntimeSessions: () => mixed,
      readRuntimeDispatches: () => mixed.map(runtimeDispatch),
      readTaskRuntimeBatch: ({ taskIds }: { readonly taskIds: readonly string[] }) => ({
        rows: taskIds.map((taskId) => ({ taskId, title: taskId, packagePath: null, sessions: mixed })),
      }),
      read: (taskId: string) => ({ snapshot: { task: { title: taskId } } }),
      getEntity: (_kind: string, id: string) => ({ value: { name: id } }),
    } as unknown as TaskProjection,
    store: {} as never,
    stream: {} as never,
    now: () => "2026-08-26T12:00:00.000Z",
    readDispatches: () => [],
  });
  assert.equal(reads.sessionGroups({}).groups.find(({ key }) => key === "task-m")?.latestStatus, "succeeded");
  const failedMembers = reads.sessionGroups({ status: ["failed"] });
  assert.deepEqual(
    failedMembers.groups.map(({ key, sessionCount, latestStatus }) => ({ key, sessionCount, latestStatus })),
    [{ key: "task-m", sessionCount: 1, latestStatus: "failed" }],
  );
  assert.deepEqual(failedMembers.totals, { groups: 1, sessions: 1 });
});

test("each unattributed bucket names the thing that is actually missing", () => {
  const reads = statusReads();
  // 阴性对照:重命名不得改变会话数,只改变桶的身份。
  const byTask = reads.sessionGroups({ groupBy: "task", since: SINCE_ALL }),
    bySquad = reads.sessionGroups({ groupBy: "squad", since: SINCE_ALL });
  assert.equal(byTask.totals.sessions, 4);
  assert.equal(bySquad.totals.sessions, 4);
  // 无 task 绑定且无派工行 → 缺的是派工记录(跨节点派工在本节点也是这个形状)。
  assert.deepEqual(
    byTask.groups.filter(({ kind }) => kind === "unattributed").map(({ key, label }) => ({ key, label })),
    [{ key: "unattributed:no-dispatch", label: "No dispatch record" }],
  );
  // squad 维度:有派工行但无 squadId 与完全无派工行,是两个桶而不是一个「未归属」。
  assert.deepEqual(
    bySquad.groups.map(({ key, kind, sessionCount }) => ({ key, kind, sessionCount })),
    [
      { key: "core-squad", kind: "squad", sessionCount: 1 },
      { key: "unattributed:no-squad", kind: "unattributed", sessionCount: 2 },
      { key: "unattributed:no-dispatch", kind: "unattributed", sessionCount: 1 },
    ],
  );
  assert.deepEqual(
    bySquad.groups.filter(({ kind }) => kind === "unattributed").map(({ label }) => label),
    ["No squad", "No dispatch record"],
  );
  // 未归属沉底仍然生效:命名的组在前,两个未归属桶在后。
  assert.deepEqual(
    bySquad.groups.map(({ kind }) => kind),
    ["squad", "unattributed", "unattributed"],
  );
  // agent 维度实测不产桶:无 agentId 的会话落进 instance:<id> 组。
  const byAgent = reads.sessionGroups({ groupBy: "agent", since: SINCE_ALL });
  assert.deepEqual(
    byAgent.groups.filter(({ kind }) => kind === "unattributed"),
    [],
  );
  assert.deepEqual(
    byAgent.groups.map(({ key }) => key).filter((key) => key.startsWith("instance:")),
    ["instance:instance-direct"],
  );
});

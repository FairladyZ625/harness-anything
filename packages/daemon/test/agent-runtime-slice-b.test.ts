// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  eventObjectTarget,
  makeTaskEventStore,
  makeTaskProjection,
  type AgentDefinitionSnapshot,
  type AgentRuntimeEventV1,
  type FrozenWritePlan,
  type RuntimeSession,
} from "../../kernel/src/index.ts";
import { makeAgentRuntimeReadModel } from "../src/agent-runtime-read.ts";
import { validateAgentRuntimeOverview } from "../src/agent-runtime-contract.ts";
import { makeAgentRuntimeStreamHub } from "../src/agent-runtime-stream.ts";
import { readFleetRuntimeSessionsPaged } from "../src/fleet-edge-runtime.ts";
import {
  daemonGuiReadMethods,
  daemonStreamFacets,
  jsonRpcMethodContracts,
  validateDaemonRpcCall,
  validateDaemonTaskDispatches,
} from "../src/protocol/daemon-protocol.contract.ts";
import {
  parseDaemonGuiReadResult,
  parseDaemonStreamEvent,
  parseDaemonStreamResult,
} from "../src/protocol/gui-result-validation.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import type { DaemonHost } from "../src/daemon-host.ts";

const actor = { principal: { personId: "person-runtime" }, executor: null } as const;
test("runtime read facets expose safe overview/session/events through the shared contract registry", () =>
  withRuntime(({ store, projection, stream, events }) => {
    const reads = makeAgentRuntimeReadModel({ store, projection, stream, runtimeInstances: () => [instanceSummary] }),
      overview = parseDaemonGuiReadResult("repo.agentRuntime.overview", reads.overview({}));
    assert.deepEqual(
      daemonGuiReadMethods.filter(({ phase }) => phase === "Runtime-B").map(({ method }) => method),
      [
        "repo.agentRuntime.overview",
        "repo.agentRuntime.sessionGroups",
        "repo.agentRuntime.sessions.read",
        "repo.agentRuntime.events.read",
        "repo.task.dispatches",
        "repo.agent.entities.list",
        "repo.agent.entity.read",
        "repo.agent.skills.list",
        "repo.squad.entities.list",
        "repo.squad.entity.read",
        "repo.squad.runs.list",
        "repo.squad.run.read",
      ],
    );
    assert.deepEqual(
      daemonStreamFacets.filter(({ phase }) => phase === "Runtime-B").map(({ method }) => method),
      ["repo.agentRuntime.attach"],
    );
    assert.equal(
      ["repo.agentRuntime.attach", "repo.terminal.attach"].every((method) =>
        daemonStreamFacets.some((facet) => facet.method === method),
      ),
      true,
    );
    assert.equal(
      jsonRpcMethodContracts.some(({ method }) => method === "repo.agentRuntime.attach"),
      true,
    );
    assert.deepEqual(overview.instances, [instanceSummary]);
    assert.deepEqual(overview.sessions[0]?.liveness, "live");
    assert.deepEqual(overview.sessions[0]?.associations[0], {
      taskId: "task-runtime",
      executionId: "execution-runtime",
      holder: null,
      lease: null,
    });
    assert.deepEqual(
      reads.overview({ taskId: "task-runtime" }).sessions.map(({ runtimeSessionId }) => runtimeSessionId),
      ["runtime-session"],
    );
    assert.deepEqual(overview.sessions[0]?.definitionSnapshot, definition);
    assert.deepEqual(secretKeys(overview), []);
    assert.deepEqual(
      reads.session({ runtimeSessionId: "runtime-session" }).session.runtimeSessionId,
      "runtime-session",
    );
    const lifecycle = reads.events({
      runtimeSessionId: "runtime-session",
      afterCursor: `lifecycle:${events[2]!.workspaceRevision}`,
    });
    assert.deepEqual(
      lifecycle.events.map(({ type }) => type),
      ["runtime_session_task_bound"],
    );
    assert.equal(lifecycle.cursor, `lifecycle:${store.read().revision}`);
    assert.notEqual(validateAgentRuntimeOverview({ ...overview, credential: "secret" }).length, 0);
    assert.notEqual(
      validateAgentRuntimeOverview({ ...overview, instances: [{ ...overview.instances[0], credentialRef: "secret" }] })
        .length,
      0,
    );
  }));

test("one stream parser validates agent-runtime and terminal facets by method", () => {
  const agentInitial = {
      ok: true,
      status: "attached",
      runtimeSessionId: "runtime-shared-parser",
      cursor: "stream:0",
      events: [],
    },
    agentEvent = {
      schema: "agent-runtime-attach-event/v1",
      type: "heartbeat",
      runtimeSessionId: "runtime-shared-parser",
      cursor: "stream:1",
      occurredAt: "2026-08-27T00:00:00.000Z",
    },
    terminalInitial = {
      schema: "terminal-attach/v1",
      ok: true,
      sessionId: "terminal-shared-parser",
      attachmentId: "attachment-shared-parser",
      daemonGeneration: 1,
      status: "attached",
      replayFromSeq: 0,
      outputSeq: 0,
    },
    terminalEvent = {
      schema: "terminal-attach-event/v1",
      sessionId: "terminal-shared-parser",
      seq: 1,
      kind: "output",
      utf8: "ready\n",
      droppedThrough: null,
      occurredAt: "2026-08-27T00:00:00.000Z",
    };
  assert.equal(parseDaemonStreamResult("repo.agentRuntime.attach", agentInitial), agentInitial);
  assert.equal(parseDaemonStreamEvent("repo.agentRuntime.attach", agentEvent), agentEvent);
  assert.equal(parseDaemonStreamResult("repo.terminal.attach", terminalInitial), terminalInitial);
  assert.equal(parseDaemonStreamEvent("repo.terminal.attach", terminalEvent), terminalEvent);
  assert.throws(
    () => parseDaemonStreamResult("repo.terminal.attach", agentInitial),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_result",
  );
  assert.throws(
    () => parseDaemonStreamEvent("repo.agentRuntime.attach", terminalEvent),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_result",
  );
});

test("runtime overview batches definitions while a single-session read selects one dispatch", () =>
  withRuntime(({ store, projection, stream }) => {
    let fullTaskListReads = 0,
      taskStatusReads = 0,
      singleDispatchReads = 0,
      batchDispatchReads = 0;
    const measured = new Proxy(projection, {
      get: (target, property, receiver) => {
        if (property === "list") fullTaskListReads += 1;
        if (property === "readTaskStatuses") taskStatusReads += 1;
        if (property === "readRuntimeDispatch") singleDispatchReads += 1;
        if (property === "readRuntimeDispatches") batchDispatchReads += 1;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const reads = makeAgentRuntimeReadModel({ store, projection: measured, stream });
    reads.overview({});
    reads.session({ runtimeSessionId: "runtime-session" });
    assert.deepEqual(
      { fullTaskListReads, taskStatusReads, singleDispatchReads, batchDispatchReads },
      { fullTaskListReads: 0, taskStatusReads: 2, singleDispatchReads: 2, batchDispatchReads: 0 },
    );
  }));

test("runtime session reads resolve a task dispatch after synchronizing its projection", () =>
  withRuntime(({ store, projection, stream }) => {
    let synchronized = false;
    const original = projection.readTaskStatuses.bind(projection);
    const measured = new Proxy(projection, {
      get: (target, property, receiver) => {
        if (property === "readTaskStatuses")
          return (...args: Parameters<typeof original>) => {
            const result = original(...args);
            synchronized = true;
            return result;
          };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const synchronizedReads = makeAgentRuntimeReadModel({
      readDispatch: (taskId, dispatchId) => {
        assert.equal(synchronized, true);
        assert.deepEqual({ taskId, dispatchId }, { taskId: "task-runtime", dispatchId: "dispatch-runtime" });
        return { runtimeSessionId: "runtime-session" };
      },
      projection: measured,
      store,
      stream,
    });
    assert.equal(
      synchronizedReads.session({ taskId: "task-runtime", dispatchId: "dispatch-runtime" }).session.runtimeSessionId,
      "runtime-session",
    );
  }));

test("runtime overview pages at the server before DTO and dispatch expansion", () =>
  withRuntime(({ store, projection, stream, session }) => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      ...session,
      runtimeSessionId: `runtime-${String(index).padStart(2, "0")}`,
    }));
    let unboundedReads = 0,
      exactDispatchReads = 0,
      pageQuery: unknown;
    const measured = new Proxy(projection, {
      get: (target, property, receiver) => {
        if (property === "readRuntimeSessions")
          return () => {
            unboundedReads += 1;
            return [...rows, ...rows];
          };
        if (property === "readRuntimeSessionPage")
          return (query: unknown) => {
            pageQuery = query;
            return { rows, nextRuntimeSessionId: "runtime-11", remainingCount: 13 };
          };
        if (property === "readRuntimeDispatch")
          return (runtimeSessionId: string) => {
            exactDispatchReads += 1;
            return { ...dispatch(), payload: { ...dispatch().payload, runtimeSessionId } };
          };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const overview = makeAgentRuntimeReadModel({ store, projection: measured, stream }).overview({ limit: 12 });
    assert.equal(overview.sessions.length, 12);
    assert.equal(unboundedReads, 0);
    assert.equal(exactDispatchReads, 12);
    assert.deepEqual(pageQuery, { limit: 12 });
    assert.deepEqual(overview.page, {
      limit: 12,
      cursor: null,
      nextCursor: "runtime-session:runtime-11",
      remainingCount: 13,
    });
  }));

test("fleet runtime adoption keeps every overview response below the negotiated frame ceiling", async (t) =>
  withRuntime(async ({ store, projection, stream }) => {
    const base = makeAgentRuntimeReadModel({ store, projection, stream }).overview({}),
      sessions = Array.from({ length: 192 }, (_, index) => ({
        ...base.sessions[0]!,
        runtimeSessionId: `runtime-${String(index).padStart(4, "0")}-${"x".repeat(256)}`,
      })),
      unboundedBytes = Buffer.byteLength(JSON.stringify({ ...base, sessions })),
      payloads: Record<string, unknown>[] = [],
      responseBytes: number[] = [];
    const selected = await readFleetRuntimeSessionsPaged(async (payload) => {
      payloads.push(payload);
      const cursor = typeof payload.cursor === "string" ? Number(payload.cursor.slice("page:".length)) : 0,
        limit = Number(payload.limit),
        pageSessions = sessions.slice(cursor, cursor + limit),
        next = cursor + pageSessions.length,
        response = {
          ...base,
          sessions: pageSessions,
          page: {
            limit,
            cursor: typeof payload.cursor === "string" ? payload.cursor : null,
            nextCursor: next < sessions.length ? `page:${next}` : null,
            remainingCount: Math.max(0, sessions.length - next),
          },
        };
      responseBytes.push(Buffer.byteLength(JSON.stringify(response)));
      return response;
    });
    assert.ok(unboundedBytes > 98_304, `unbounded overview measured ${unboundedBytes} bytes`);
    assert.ok(Math.max(...responseBytes) < 98_304, `largest page measured ${Math.max(...responseBytes)} bytes`);
    assert.equal(selected.length, sessions.length);
    assert.deepEqual(payloads.slice(0, 2), [{ limit: 16 }, { limit: 16, cursor: "page:16" }]);
    t.diagnostic(
      `overview bytes: unbounded=${unboundedBytes} maxPage=${Math.max(...responseBytes)} pages=${responseBytes.length}`,
    );
  }));

test("attach catches up from cursor, gaps require snapshot, and unsupported is typed", async () =>
  withRuntime(async ({ stream, session }) => {
    for (let index = 0; index < 3; index += 1)
      stream.publish(session.runtimeSessionId, {
        type: "activity",
        activity: index === 2 ? "message" : "thinking",
        content: `content-${index}`,
      });
    const resumed = stream.attach(session.runtimeSessionId, "stream:1");
    assert.equal(resumed.initial.ok && resumed.initial.status, "attached");
    assert.deepEqual(resumed.initial.ok && resumed.initial.events.map(({ cursor }) => cursor), [
      "stream:2",
      "stream:3",
    ]);
    resumed.detach();
    for (let index = 0; index < 35; index += 1) stream.publish(session.runtimeSessionId, { type: "heartbeat" });
    const gap = stream.attach(session.runtimeSessionId, "stream:0");
    assert.equal(gap.initial.ok && gap.initial.status, "gap");
    assert.deepEqual(gap.initial.ok && gap.initial.events[0], {
      schema: "agent-runtime-attach-event/v1",
      type: "gap",
      runtimeSessionId: "runtime-session",
      cursor: "stream:38",
      occurredAt: "2026-08-13T00:00:00.000Z",
      required: "snapshot",
    });
    gap.detach();
    const restarted = makeAgentRuntimeStreamHub({
      readSession: () => session,
      canAttach: ({ attachable }) => attachable,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    }).attach(session.runtimeSessionId, "stream:38");
    assert.equal(restarted.initial.ok && restarted.initial.status, "gap");
    assert.equal(restarted.initial.ok && restarted.initial.events[0]?.type, "gap");
    restarted.detach();
    session.attachable = false;
    const unsupported = stream.attach(session.runtimeSessionId, "stream:38").initial;
    assert.deepEqual(unsupported, {
      ok: false,
      code: "unsupported",
      runtimeSessionId: "runtime-session",
      hint: "This provider session does not expose read-only live frames.",
    });
    session.attachable = true;
    const capabilityMissing = makeAgentRuntimeStreamHub({ readSession: () => session, canAttach: () => false }).attach(
      session.runtimeSessionId,
      "stream:0",
    ).initial;
    assert.equal(capabilityMissing.ok, false);
    assert.equal(!capabilityMissing.ok && capabilityMissing.code, "unsupported");
  }));

test("slow subscribers gap without blocking daemon writer requests, and detach does not alter the native session", async () =>
  withRuntime(async ({ stream, session }) => {
    const slow = stream.attach(session.runtimeSessionId, "stream:0"),
      before = structuredClone(session),
      started = performance.now();
    for (let index = 0; index < 2_000; index += 1) stream.publish(session.runtimeSessionId, { type: "heartbeat" });
    const elapsed = performance.now() - started;
    assert.equal(elapsed < 200, true, `publication took ${elapsed}ms`);
    assert.equal((await slow.next())?.type, "gap");
    slow.detach();
    assert.equal(await slow.next(), null);
    assert.deepEqual(session, before);
    let writes = 0;
    const host = {
      attach: async (_repoId: string, runtimeSessionId: string, afterCursor: string) =>
        stream.attach(runtimeSessionId, afterCursor),
      run: async () => {
        writes += 1;
        return { outcome: "applied", opId: "writer-op" };
      },
      read: async () => ({}),
      bootstrap: async () => ({}),
      admin: async () => ({}),
      issueRuntimeWitness: async () =>
        stream.issueWitnessToken(session.runtimeSessionId, { principalId: "person-owner", source: "local" }),
      bindRuntimeWitness: (_repoId: string, token: string) => stream.bindWitness(token),
      publishRuntimeWitness: (_repoId: string, token: string, signal: Parameters<typeof stream.publish>[1]) =>
        stream.publish(stream.bindWitness(token).runtimeSessionId, signal),
      status: () => ({ daemonId: "runtime-test", pid: process.pid, repos: [] }),
      close: async () => undefined,
    } as unknown as DaemonHost;
    const server = createJsonRpcProtocolServer({
      host,
      build: { commit: null },
      authContext: { transportKind: "unix-socket" },
      emit: () => new Promise(() => undefined),
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion },
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "repo.agentRuntime.attach",
      params: {
        repo: { repoId: "runtime-test" },
        payload: { runtimeSessionId: session.runtimeSessionId, afterCursor: "stream:2000" },
      },
    });
    stream.publish(session.runtimeSessionId, { type: "heartbeat" });
    const written = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "repo.task.create",
      params: { repo: { repoId: "runtime-test" }, payload: { title: "Runtime" } },
    });
    assert.equal(writes, 1);
    assert.equal(!Array.isArray(written) && written && "result" in written && written.result.ok, true);
    server.close();
  }));

test("daemon witness token binds a session-scoped agent executor from server state and ignores provider identity fields", () =>
  withRuntime(({ stream, session }) => {
    const issued = stream.issueWitnessToken(session.runtimeSessionId, { principalId: "person-owner", source: "local" }),
      bound = stream.bindWitness(issued.token);
    assert.deepEqual(bound, {
      runtimeSessionId: session.runtimeSessionId,
      actor: {
        principal: { personId: "person-owner" },
        executor: { kind: "agent", id: `runtime-session:${session.runtimeSessionId}` },
      },
      source: "local",
    });
    assert.deepEqual(stream.bindWitness(issued.token), bound);
    assert.throws(() => stream.bindWitness("provider-supplied"), /missing or expired/iu);
  }));

test("task writes keep aggregate CAS after runtime events advance the shared workspace revision", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-task-cas-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("runtime-cas"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "runtime-cas-1",
    });
    const binding = { actor, source: "local" as const },
      created = await cell.run({ kind: "task-create", taskId: "task-runtime", title: "Runtime CAS" }, binding);
    assert.equal(created.outcome, "applied");
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    await cell.close();
    cell = undefined;
    const runtime = fixtureAtRevision(rootDir, makeTaskEventStore({ repoId: "runtime-cas", rootDir }).read().revision + 1);
    for (const event of runtime)
      makeTaskEventStore({ repoId: "runtime-cas", rootDir }).append({
        event,
        plan: runtimeWritePlan(event),
        blobs: [],
      });
    cell = await openRepoCell({
      repoId: workspaceId("runtime-cas"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "runtime-cas-2",
    });
    assert.equal(
      (
        await cell.run(
          { kind: "task-start", taskId: "task-runtime", executionId: "execution-runtime" },
          binding,
        )
      ).outcome,
      "applied",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task dispatch read accepts one bounded batch and degrades missing tasks per row", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-dispatch-batch-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("runtime-dispatch-batch"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "runtime-dispatch-batch",
    });
    for (const [taskId, title] of [
      ["task-batch-a", "Batch A"],
      ["task-batch-b", "Batch B"],
    ] as const)
      assert.equal(
        (await cell.run({ kind: "task-create", taskId, title }, { actor, source: "local" })).outcome,
        "applied",
      );
    const result = await cell.read("repo.task.dispatches", {
      taskIds: ["task-batch-a", "task-batch-b", "task-missing"],
    });
    assert.deepEqual("taskIds" in result && result.taskIds, ["task-batch-a", "task-batch-b", "task-missing"]);
    assert.deepEqual("unavailableTaskIds" in result && result.unavailableTaskIds, ["task-missing"]);
    assert.deepEqual(result.dispatches, []);
    assert.deepEqual(validateDaemonTaskDispatches(result), []);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task dispatch batch wire contract keeps the single selector compatible and closes invalid mixtures", () => {
  const call = (payload: Record<string, unknown>) =>
    validateDaemonRpcCall({ method: "repo.task.dispatches", params: { repo: { repoId: "runtime-b" }, payload } });
  assert.deepEqual(call({ taskId: "task-a" }), []);
  assert.deepEqual(call({ taskIds: ["task-a", "task-b"], limit: 2 }), []);
  assert.notDeepEqual(call({ taskId: "task-a", taskIds: ["task-b"] }), []);
  assert.notDeepEqual(call({ taskIds: ["task-a", "task-a"] }), []);
  assert.notDeepEqual(call({ taskIds: [] }), []);
});

async function withRuntime<T>(use: (fixture: ReturnType<typeof fixture>) => T | Promise<T>): Promise<T> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-b-"));
  let current: ReturnType<typeof fixture> | undefined;
  try {
    initRepo(rootDir);
    current = fixture(rootDir);
    return await use(current);
  } finally {
    current?.projection.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}
function fixture(rootDir: string) {
  const store = makeTaskEventStore({ repoId: "runtime-b", rootDir }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    events = [installation(), dispatch(), started(), taskBound()];
  for (const event of events) {
    store.append({ event, plan: runtimeWritePlan(event), blobs: [] });
    projection.apply(event);
  }
  const session = projection.readRuntimeSession("runtime-session") as RuntimeSession & { attachable: boolean },
    fixedNow = new Date("2026-08-13T00:00:00.000Z"),
    stream = makeAgentRuntimeStreamHub({
      readSession: () => session,
      canAttach: ({ attachable }) => attachable,
      now: () => fixedNow,
    });
  return { store, projection, stream, events, session };
}
function runtimeWritePlan(event: AgentRuntimeEventV1): FrozenWritePlan {
  return Object.freeze({
    commandType: event.type,
    targets: Object.freeze(
      [
        { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
        { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
        { kind: "projection_invalidation", projection: "agent-runtime/v1", key: event.opId },
      ].map((target) => Object.freeze(target)),
    ),
  }) as FrozenWritePlan;
}
function event<T extends AgentRuntimeEventV1["type"]>(
  type: T,
  payload: Extract<AgentRuntimeEventV1, { readonly type: T }>["payload"],
  revision: number,
): AgentRuntimeEventV1 {
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    actor,
    source: "local",
    occurredAt: `2026-08-13T00:00:0${revision}.000Z`,
    type,
    payload,
  } as AgentRuntimeEventV1;
}
function installation(): AgentRuntimeEventV1 {
  return event(
    "runtime_installation_observed",
    {
      installationId: "installation-runtime",
      kindId: "codex",
      protocolFamily: "codex",
      hostRef: "host:local",
      version: "1.0.0",
      discoverySource: "wrapper",
      capabilities: ["structured_witness", "attach"],
    },
    1,
  );
}
function dispatch(): AgentRuntimeEventV1 {
  return event(
    "runtime_dispatch_requested",
    {
      dispatchId: "dispatch-runtime",
      runtimeSessionId: "runtime-session",
      instanceId: definition.instanceId,
      installationId: definition.installationId,
      kindId: definition.kindId,
      idempotencyKey: "runtime-once",
      definitionSnapshotRef: "artifact:runtime-definition/test",
      definitionSnapshot: definition,
    },
    2,
  );
}
function started(): AgentRuntimeEventV1 {
  return event(
    "runtime_session_started",
    {
      runtimeSessionId: "runtime-session",
      instanceId: definition.instanceId,
      installationId: definition.installationId,
      kindId: definition.kindId,
      definitionSnapshotRef: "artifact:runtime-definition/test",
      launchGeneration: 1,
      attachable: true,
    },
    3,
  );
}
function taskBound(): AgentRuntimeEventV1 {
  return event(
    "runtime_session_task_bound",
    {
      runtimeSessionId: "runtime-session",
      taskId: "task-runtime",
      executionId: "execution-runtime",
      providerSessionId: "provider-runtime",
      transcriptRef: "file:runtime/session.jsonl",
    },
    4,
  );
}
function fixtureAtRevision(_rootDir: string, revision: number): AgentRuntimeEventV1[] {
  const values = [installation(), dispatch(), started()];
  return values.map(
    (value, index) =>
      ({
        ...value,
        eventId: `event-cas-${revision + index}`,
        opId: `op-cas-${revision + index}`,
        workspaceRevision: revision + index,
        occurredAt: `2026-08-13T00:01:0${index}.000Z`,
      }) as AgentRuntimeEventV1,
  );
}
const definition: AgentDefinitionSnapshot = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "instance-runtime",
  installationId: "installation-runtime",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  baseUrl: "https://runtime.example/v1",
  authMode: "api-key",
};
const instanceSummary = {
  schemaVersion: 2,
  instanceId: definition.instanceId,
  name: "Runtime fixture",
  kindId: definition.kindId,
  installationId: definition.installationId,
  providerId: definition.providerId,
  models: [definition.model],
  defaultModel: definition.model,
  enabled: true,
  permissionMode: "bypass",
  codex: {
    reasoningEffort: definition.reasoningEffort,
    baseUrl: definition.baseUrl,
    baseUrlConfigured: true,
    wire_api: null,
    requires_openai_auth: null,
    http_headers: null,
  },
  authMode: definition.authMode,
  authState: "configured",
  authReadiness: { status: "ready", code: null, hint: null },
  isolationState: "enforced",
} as const;
function secretKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => secretKeys(item, found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, item] of Object.entries(value)) {
    if (["credential", "secret", "token", "transcript", "stdout", "stderr"].includes(key)) found.push(key);
    secretKeys(item, found);
  }
  return found;
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Runtime B Test");
  git(rootDir, "config", "user.email", "runtime-b@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

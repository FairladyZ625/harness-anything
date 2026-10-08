// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  authorizedOrThrow,
  buildFleetOverview,
  FLEET_CENTER_NODE_ID,
  readFleetOverviewFromHost,
  validateFleetOverview,
  type FleetCanonicalEventFact,
  type FleetDispatchFact,
  type FleetLeaseFact,
  type FleetOverviewInput,
} from "../src/fleet/fleet-overview-read.ts";
import type { FleetReplicaStatus } from "../src/fleet/center-types.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";

const CENTER = { daemonId: "default", startedAt: "2026-10-01T00:00:00.000Z", version: "0.0.0", commitSha: "bd2251a" };

function replica(nodeId: string, overrides: Partial<FleetReplicaStatus> = {}): FleetReplicaStatus {
  return {
    nodeId,
    viewId: `view-${nodeId}`,
    repoId: "repo-test",
    centerRevision: 164,
    centerEventAt: "2026-10-06T00:30:00.000Z",
    centerManifestBytes: 1024,
    ackRevision: 164,
    ackCutEventAt: "2026-10-06T00:30:00.000Z",
    ackedAt: "2026-10-06T00:30:01.000Z",
    lagRevisions: 0,
    lagMs: 1_000,
    catchUpBytes: 0,
    delivery: "current",
    activeTransfers: 0,
    deliveryLease: null,
    transferMetrics: { transferBytes: 0, snapshotStarts: 0, deltaStarts: 0, errors: 0, lastFailureCode: null },
    sendWindowBytes: 0,
    sendQuotaBytes: 0,
    diskQuotaBytes: null,
    ...overrides,
  };
}

function lease(taskId: string, nodeId: string | null, overrides: Partial<FleetLeaseFact> = {}): FleetLeaseFact {
  return {
    taskId,
    title: `任务 ${taskId}`,
    coordinationStatus: "active",
    leasePhase: "held",
    leaseExpiresAt: "2026-10-07T00:00:00.000Z",
    personId: "person_zeyu",
    executorId: `runtime-session:runtime_${taskId}`,
    nodeId,
    ...overrides,
  };
}

function dispatch(taskId: string, overrides: Partial<FleetDispatchFact> = {}): FleetDispatchFact {
  return {
    dispatchId: `dispatch_${taskId}`,
    taskId,
    runtimeSessionId: `runtime_${taskId}`,
    agentId: "agent_worker",
    agentName: "Worker",
    startedAt: "2026-10-06T00:20:00.000Z",
    status: "running",
    ...overrides,
  };
}

function event(eventId: string, overrides: Partial<FleetCanonicalEventFact> = {}): FleetCanonicalEventFact {
  return {
    eventId,
    type: "task_status_changed",
    occurredAt: "2026-10-06T00:28:00.000Z",
    workspaceRevision: 163,
    taskId: null,
    executorId: null,
    title: null,
    ...overrides,
  };
}

function input(overrides: Partial<FleetOverviewInput> = {}): FleetOverviewInput {
  return {
    repoId: "repo-test",
    mode: "remote-center",
    generatedAt: "2026-10-06T01:00:00.000Z",
    center: CENTER,
    replicas: [],
    leaseReads: { ok: true, leases: [], dispatches: [] },
    events: [],
    nodeOwners: new Map(),
    centerRevision: 164,
    ...overrides,
  };
}

test("the overview joins daemon facts: center node from daemon identity, edges from replica ledger and leases", () => {
  const result = buildFleetOverview(
    input({
      replicas: [
        replica("cc90-ubuntu"),
        replica("macos-user", { delivery: "snapshot_required", ackRevision: null, lagRevisions: 164 }),
      ],
      leaseReads: {
        ok: true,
        leases: [lease("task_1", FLEET_CENTER_NODE_ID), lease("task_2", "cc90-ubuntu"), lease("task_4", "ghost-node")],
        dispatches: [dispatch("task_2", { agentId: "agent_worker", agentName: "Worker" })],
      },
      nodeOwners: new Map([["cc90-ubuntu", { kind: "value", text: "person_zeyu" }]]),
    }),
  );
  assert.deepEqual(
    result.nodes.map((node) => [node.nodeId, node.role]),
    [
      ["center", "center"],
      ["cc90-ubuntu", "edge"],
      ["ghost-node", "edge"],
      ["macos-user", "edge"],
    ],
  );
  const ubuntu = result.nodes.find((node) => node.nodeId === "cc90-ubuntu")!;
  assert.equal(ubuntu.replica?.ackRevision, 164);
  assert.equal(ubuntu.replica?.deliveryLease, null);
  assert.deepEqual(ubuntu.replica?.transferMetrics, replica("cc90-ubuntu").transferMetrics);
  assert.equal(ubuntu.owner.kind, "value");
  assert.deepEqual(
    ubuntu.leases instanceof Array && ubuntu.leases.map((row) => [row.taskId, row.agentLabel, row.runtimeSessionId]),
    [["task_2", "Worker", "runtime_task_2"]],
  );
  const center = result.nodes[0]!;
  assert.equal(center.build.kind, "value");
  assert.match(center.build.text, /bd2251a/);
  assert.equal(center.online.kind, "value");
  // 租约来源节点但副本账本没有行的节点如实标注,不静默消失。
  const ghost = result.nodes.find((node) => node.nodeId === "ghost-node")!;
  assert.equal(ghost.replica, null);
  // replicaNote 是稳定机器码(人话解释归 GUI i18n),不带内嵌文案。
  assert.equal(ghost.replicaNote, "center-replica-ledger-has-no-row-for-node");
  assert.deepEqual(
    result.links.map((link) => [link.nodeId, link.state]),
    [
      ["cc90-ubuntu", "fresh"],
      ["macos-user", "unsynced"],
    ],
  );
  assert.equal(parseDaemonGuiReadResult("repo.fleet.overview.read", result), result);
});

test("the node-level replica is the view the node last acknowledged, never a frozen retired view", () => {
  // 测试床 B2:升级后节点带着 nodeId 命名的新 view 拉取,静态 assignment 时代的旧 view 行
  // 冻结在台账里 ack 永不前进;节点级摘要若取最旧 ack 行,健康节点被画成严重滞后。
  const result = buildFleetOverview(
    input({
      replicas: [
        replica("cc90-ubuntu", {
          viewId: "cc90-ubuntu-schedule-view",
          ackRevision: 26,
          ackCutEventAt: "2026-10-05T00:00:00.000Z",
          ackedAt: "2026-10-05T00:00:01.000Z",
          lagRevisions: 385,
          lagMs: 86_400_000,
          catchUpBytes: 1024,
          delivery: "snapshot_required",
        }),
        replica("cc90-ubuntu", { viewId: "cc90-ubuntu", ackRevision: 411 }),
      ],
    }),
  );
  const ubuntu = result.nodes.find((node) => node.nodeId === "cc90-ubuntu")!;
  assert.equal(ubuntu.replica?.viewId, "cc90-ubuntu");
  assert.equal(ubuntu.replica?.ackRevision, 411);
  assert.equal(ubuntu.replica?.lagRevisions, 0);
  assert.equal(ubuntu.replica?.delivery, "current");
  // 回收发生在该节点下一次 ACK 落地时(ack store 退役清扫);清扫前的窗口里多 view 仍在 links 逐条明示。
  assert.deepEqual(
    result.links.map((link) => [link.nodeId, link.state]),
    [
      ["cc90-ubuntu", "fresh"],
      ["cc90-ubuntu", "unsynced"],
    ],
  );
});

test("edge fields the read surface cannot see are unavailable with a reason, never invented", () => {
  const result = buildFleetOverview(
    input({ replicas: [replica("cc90-ubuntu", { lagRevisions: 3, delivery: "delta" })] }),
  );
  const edge = result.nodes.find((node) => node.nodeId === "cc90-ubuntu")!;
  assert.deepEqual(
    { build: edge.build.kind, online: edge.online.kind, watch: edge.watch.kind, lastFailure: edge.lastFailure.kind },
    { build: "unavailable", online: "unavailable", watch: "unavailable", lastFailure: "unavailable" },
  );
  assert.equal(edge.online.reason, "tls-session-fact-not-exposed");
  // notes 是稳定 key=value 机器码;人话解释归 GUI i18n,daemon 不内嵌单语言文案。
  assert.deepEqual(result.notes, [
    "events-attribution=current-lease",
    "edge-online=unavailable",
    "sync-internals=unavailable",
  ]);
  assert.equal(result.links[0]!.state, "lag");
});

test("events are attributed by the task's current lease, executor session join, else the center", () => {
  const result = buildFleetOverview(
    input({
      leaseReads: {
        ok: true,
        leases: [lease("task_2", "cc90-ubuntu"), lease("task_3", FLEET_CENTER_NODE_ID)],
        dispatches: [dispatch("task_3")],
      },
      events: [
        event("evt-1", { taskId: "task_2" }),
        event("evt-2", { executorId: "runtime-session:runtime_task_3" }),
        event("evt-3"),
        event("evt-4", { executorId: "runtime-session:runtime_unknown" }),
      ],
    }),
  );
  assert.deepEqual(
    result.events.map((row) => [row.eventId, row.nodeId]),
    [
      ["evt-1", "cc90-ubuntu"],
      ["evt-2", FLEET_CENTER_NODE_ID],
      ["evt-3", FLEET_CENTER_NODE_ID],
      ["evt-4", FLEET_CENTER_NODE_ID],
    ],
  );
});

test("authorization failures become redacted lease blocks; other failures propagate (fail-closed)", async () => {
  const denied = await authorizedOrThrow(async () => {
    throw Object.assign(new Error("denied"), { code: "authorization_denied" });
  });
  assert.deepEqual(denied, { ok: false, code: "authorization_denied" });
  const scope = await authorizedOrThrow(async () => {
    throw Object.assign(new Error("scope"), { code: "insufficient_scope" });
  });
  assert.equal(scope.ok, false);
  await assert.rejects(
    authorizedOrThrow(async () => {
      throw Object.assign(new Error("repo warming"), { code: "repo_warming" });
    }),
    /repo warming/,
  );
  await assert.rejects(
    authorizedOrThrow(async () => {
      throw new Error("plain failure");
    }),
    /plain failure/,
  );
  const result = buildFleetOverview(
    input({
      replicas: [replica("cc90-ubuntu")],
      leaseReads: { ok: false, code: "authorization_denied" },
    }),
  );
  const edge = result.nodes.find((node) => node.nodeId === "cc90-ubuntu")!;
  assert.deepEqual(edge.leases, { redacted: "authorization_denied" });
  assert.equal(parseDaemonGuiReadResult("repo.fleet.overview.read", result), result);
});

test("the validator accepts a real overview and rejects the pinned negative fixture", () => {
  const good = buildFleetOverview(
    input({
      replicas: [replica("cc90-ubuntu")],
      leaseReads: { ok: true, leases: [lease("task_1", FLEET_CENTER_NODE_ID)], dispatches: [] },
      events: [event("evt-1", { taskId: "task_1" })],
      nodeOwners: new Map([["cc90-ubuntu", { kind: "unavailable", reason: "keycloak-unreachable" }]]),
    }),
  );
  assert.deepEqual(validateFleetOverview(good), []);
  assert.ok(good.warnings.length === 1);
  const negative = JSON.parse(
    readFileSync(new URL("../fixtures/contracts/daemon-fleet-overview-invalid.json", import.meta.url), "utf8"),
  );
  assert.notDeepEqual(validateFleetOverview(negative), []);
});

test("the host assembly maps task snapshots, dispatch rows, the event tail and registry failures", async () => {
  const cell = {
    read: async (method: string) => {
      if (method === "repo.tasks.list")
        return {
          ok: true,
          status: "ready",
          rows: [
            {
              taskId: "task_local",
              coordinationStatus: "active",
              snapshot: {
                task: { title: "本机任务" },
                lease: {
                  phase: "held",
                  expiresAt: "2026-10-07T00:00:00.000Z",
                  actor: {
                    principal: { personId: "person_zeyu" },
                    executor: { kind: "agent", id: "runtime-session:runtime_local" },
                  },
                  source: "local",
                },
              },
            },
            {
              taskId: "task_edge",
              coordinationStatus: "active",
              snapshot: {
                task: { title: null },
                lease: {
                  phase: "reserving",
                  expiresAt: "2026-10-07T00:00:00.000Z",
                  actor: { principal: { personId: "person_zeyu" }, executor: null },
                  source: { kind: "node", nodeId: "cc90-ubuntu" },
                },
              },
            },
          ],
        };
      return {
        ok: true,
        status: "ready",
        dispatches: [
          {
            dispatchId: "dispatch_local",
            taskId: "task_local",
            runtimeSessionId: "runtime_local",
            agentId: "agent_ceo",
            agentName: "CEO",
            startedAt: "2026-10-06T00:10:00.000Z",
            status: "running",
          },
        ],
      };
    },
    observeTail: async () => ({
      schema: "daemon.observe-tail/v3",
      ok: true,
      repoId: "repo-test",
      mode: "remote-center",
      kind: "events",
      direction: "history",
      status: "ready",
      items: [
        {
          eventId: "evt-9",
          type: "task_bootstrapped",
          occurredAt: "2026-10-06T00:05:00.000Z",
          workspaceRevision: 150,
          taskId: "task_local",
          actor: { executor: { id: "runtime-session:runtime_local" } },
          payload: { title: "任务建立" },
        },
      ],
      historyCursor: null,
      liveCursor: null,
      sourceCursor: null,
      done: true,
    }),
    statusCuts: () => ({ projectionWatermark: 164, ledgerRevision: 164 }),
  };
  const result = await readFleetOverviewFromHost({
    repoId: "repo-test",
    mode: "remote-center",
    // The cell is a narrow stub: only the three members the read touches exist.
    cell: cell as never,
    binding: {} as never,
    fleetReplicas: [replica("cc90-ubuntu")],
    keycloakCenter: (async () => {
      throw new Error("keycloak-unreachable");
    }) as never,
    now: "2026-10-06T01:00:00.000Z",
    userRoot: "/tmp/fleet-overview-test",
    daemon: { daemonId: "default", startedAt: "2026-10-01T00:00:00.000Z" },
  });
  const center = result.nodes.find((node) => node.nodeId === "center")!;
  const localLease = (
    center.leases as { taskId: string; agentLabel: string | null; runtimeSessionId: string | null }[]
  ).find((row) => row.taskId === "task_local")!;
  assert.equal(localLease.title, "本机任务");
  assert.equal(localLease.agentLabel, "CEO");
  assert.equal(localLease.runtimeSessionId, "runtime_local");
  const ubuntu = result.nodes.find((node) => node.nodeId === "cc90-ubuntu")!;
  assert.equal(ubuntu.owner.kind, "unavailable");
  assert.equal(ubuntu.owner.reason, "keycloak-unreachable");
  assert.deepEqual(result.warnings, ["node-owner-registry-unavailable: keycloak-unreachable"]);
  assert.equal(result.events[0]!.nodeId, "center");
  assert.equal(result.events[0]!.title, "任务建立");
  assert.ok(result.center.commitSha === null || typeof result.center.commitSha === "string");
});

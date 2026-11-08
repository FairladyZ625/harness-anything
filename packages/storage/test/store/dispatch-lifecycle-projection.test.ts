// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  runtimeEventContentClaims,
  validateCurrentAgentRuntimeEvent,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { canonicalEventWritePlan, makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

const actor = { principal: { personId: "person-runtime" }, executor: null } as const;
let revision = 0;

function runtimeEvent(type: AgentRuntimeEventV1["type"], payload: Record<string, unknown>): AgentRuntimeEventV1 {
  revision += 1;
  const event = {
    schema: "agent-runtime-event/v1",
    eventId: `event-lifecycle-${revision}`,
    workspaceRevision: revision,
    opId: `op-lifecycle-${revision}`,
    actor,
    source: { kind: "node", nodeId: "node-a" },
    occurredAt: `2026-11-08T00:00:${String(revision).padStart(2, "0")}.000Z`,
    type,
    payload,
  } as AgentRuntimeEventV1;
  const errors = validateCurrentAgentRuntimeEvent(event);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return event;
}

const requested = (dispatchId: string, runtimeSessionId: string, attemptGroupId?: string) =>
  runtimeEvent("runtime_dispatch_requested", {
    dispatchId,
    runtimeSessionId,
    instanceId: "codex-fixture",
    installationId: "installation-codex",
    kindId: "codex",
    dispatchKey: `${dispatchId}-key`,
    definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
    definitionSnapshot: {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: "codex-fixture",
      installationId: "installation-codex",
      kindId: "codex",
      providerId: "openai",
      model: "codex-fixture",
      reasoningEffort: null,
      baseUrl: null,
      authMode: "subscription",
    },
    ...(attemptGroupId ? { attemptGroupId, attemptIndex: 1 } : {}),
  });
const started = (runtimeSessionId: string) =>
  runtimeEvent("runtime_session_started", {
    runtimeSessionId,
    instanceId: "codex-fixture",
    installationId: "installation-codex",
    kindId: "codex",
    definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
    launchGeneration: 1,
    attachable: false,
  });
const outcome = (runtimeSessionId: string, value: string, attempt?: Record<string, unknown>) =>
  runtimeEvent("runtime_session_outcome_observed", {
    runtimeSessionId,
    outcome: value,
    exitCode: null,
    resultRef: `artifact:runtime-result/sha256/${"0".repeat(64)}`,
    result: null,
    ...(attempt ? { attempt } : {}),
  });

function history(): AgentRuntimeEventV1[] {
  revision = 0;
  return [
    // A fallback group: the first attempt schedules a successor, which is still running.
    requested("dispatch-a", "session-a"),
    started("session-a"),
    runtimeEvent("runtime_session_exited", { runtimeSessionId: "session-a" }),
    outcome("session-a", "failed", { classification: "provider_quota", reason: "quota", fallbackState: "scheduled" }),
    requested("dispatch-a2", "session-a2", "dispatch-a"),
    started("session-a2"),
    // A dispatch whose owner lost sight of the process: it keeps its slot and blocks its owner.
    requested("dispatch-b", "session-b"),
    started("session-b"),
    runtimeEvent("runtime_session_liveness_changed", { runtimeSessionId: "session-b", liveness: "unknown" }),
    // A finished dispatch.
    requested("dispatch-c", "session-c"),
    started("session-c"),
    runtimeEvent("runtime_session_exited", { runtimeSessionId: "session-c" }),
    outcome("session-c", "succeeded"),
  ];
}

function snapshot(projection: ReturnType<typeof makeTaskProjection>) {
  const active = projection.readDispatchLifecycle({ by: "active", instanceId: "codex-fixture", limit: 10 }),
    points = projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: ["dispatch-a", "dispatch-c"] }),
    session = projection.readDispatchLifecycle({ by: "session", runtimeSessionId: "session-b" });
  return { active, points, session };
}

function initRepo(rootDir: string): void {
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Lifecycle Test"],
    ["config", "user.email", "lifecycle@example.invalid"],
    ["commit", "--allow-empty", "-qm", "base"],
  ])
    execFileSync("git", ["-C", rootDir, ...args]);
}

test("the lifecycle read model folds accepted runtime events and equals every rebuild path", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "dispatch-lifecycle", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    for (const event of history()) {
      store.append({
        event,
        plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
        blobs: runtimeEventContentClaims(event).map((claim) => ({ ...claim, body: "" })),
      });
      projection.apply(event);
    }
    const online = snapshot(projection),
      onlineDigest = projection.readStateDigest();
    assert.equal(online.active.status, "ready");
    assert.ok(online.active.status === "ready");
    assert.deepEqual(
      online.active.rows.map((row) => [
        row.attemptGroupId,
        row.groupPhase,
        row.attempt.dispatchId,
        row.policy.capacityDisposition,
      ]),
      [
        ["dispatch-a", "running", "dispatch-a2", "busy"],
        ["dispatch-b", "running", "dispatch-b", "recovering"],
      ],
    );
    assert.ok(online.points.status === "ready");
    assert.deepEqual(
      online.points.rows.map((row) => [row.attempt.dispatchId, row.attempt.phase, row.groupPhase]).sort(),
      [
        ["dispatch-a", "closed", "running"],
        ["dispatch-c", "closed", "closed"],
      ],
    );
    assert.ok(online.session.status === "ready");
    assert.equal(online.session.rows[0]?.attempt.process, "unknown");
    const projectionPath = projection.path;
    projection.close();

    // A cache written before the lifecycle tables existed, or advanced by an older binary.
    const db = new DatabaseSync(projectionPath);
    db.exec(
      "DROP TABLE dispatch_lifecycle_group; DROP TABLE dispatch_lifecycle_attempt; DROP TABLE dispatch_lifecycle_cursor;",
    );
    db.close();
    const reopened = makeTaskProjection({ rootDir, eventStore: store, projectionPath });
    assert.deepEqual(snapshot(reopened), online);
    assert.equal(reopened.readStateDigest(), onlineDigest);

    // Rewinding the fold cursor replays already folded events: the reducer accepts each once.
    reopened.close();
    const rewound = new DatabaseSync(projectionPath);
    rewound.exec("UPDATE dispatch_lifecycle_cursor SET revision = 0");
    rewound.close();
    const replayed = makeTaskProjection({ rootDir, eventStore: store, projectionPath });
    assert.deepEqual(snapshot(replayed), online);
    assert.equal(replayed.readStateDigest(), onlineDigest);

    // A cold rebuild from the event store reaches the same rows.
    replayed.rebuild();
    assert.deepEqual(snapshot(replayed), online);
    assert.equal(replayed.readStateDigest(), onlineDigest);
    replayed.close();
    await store.drain();
  });
});

test("active pages are bounded and point reads cap their key count", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "dispatch-lifecycle-page", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    for (const event of history()) {
      store.append({
        event,
        plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
        blobs: runtimeEventContentClaims(event).map((claim) => ({ ...claim, body: "" })),
      });
      projection.apply(event);
    }
    const first = projection.readDispatchLifecycle({ by: "active", limit: 1 });
    assert.ok(first.status === "ready");
    assert.deepEqual(
      first.rows.map((row) => row.attemptGroupId),
      ["dispatch-a"],
    );
    assert.equal(first.nextCursor, "dispatch-a");
    const second = projection.readDispatchLifecycle({ by: "active", limit: 1, cursor: first.nextCursor! });
    assert.ok(second.status === "ready");
    assert.deepEqual([second.rows.map((row) => row.attemptGroupId), second.nextCursor], [["dispatch-b"], null]);
    assert.throws(
      () =>
        projection.readDispatchLifecycle({
          by: "dispatch",
          dispatchIds: Array.from({ length: 101 }, (_, index) => `dispatch-${index}`),
        }),
      /at most 100 ids/u,
    );
    projection.close();
    await store.drain();
  });
});

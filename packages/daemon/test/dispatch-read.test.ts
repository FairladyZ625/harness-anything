// harness-test-tier: fast
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeEventV1, RuntimeSession, TaskProjection } from "@harness-anything/kernel";
import {
  readRuntimeAttemptChain,
  readSessionGroupDispatches,
  readTaskDispatches,
  readTaskDispatchSession,
  taskDispatchesOutcome,
  taskDispatchRowsSettled,
} from "../src/dispatch-read.ts";
import { openDecisionAnnotationStore } from "../src/decision-annotations.ts";
import type { RepoCellApiContext } from "../src/repo-cell-api.ts";
import { taskDispatchesPayloadFromCell } from "../src/repo-cell-read-payloads.ts";
import { validateDaemonTaskDispatches } from "../src/protocol/daemon-protocol.contract.ts";

const dispatchId = "dispatch_a1b2c3d4e5f60718293a4b5c",
  runtimeSessionId = "runtime-1",
  taskId = "task-1";
type Dispatch = Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>;
function session(
  liveness: RuntimeSession["liveness"],
  outcome: RuntimeSession["outcome"],
  evidence: Partial<RuntimeSession> = {},
): RuntimeSession {
  return {
    runtimeSessionId,
    instanceId: "instance-1",
    installationId: "installation-1",
    kindId: "codex",
    definitionSnapshotRef: "artifact:runtime-definition/test",
    providerSessionId: "provider-session",
    transcriptRef: null,
    launchGeneration: 1,
    liveness,
    attachable: false,
    taskBindings: [],
    outcome,
    exitCode: null,
    resultRef: null,
    lastObservedAt: "2026-08-23T00:00:00.000Z",
    ...evidence,
  };
}
function fixture(
  current = session("live", null),
  options: { archive?: Record<string, unknown>; successor?: Dispatch; metrics?: Record<string, unknown> } = {},
) {
  const event = {
    schema: "agent-runtime-event/v1",
    type: "runtime_dispatch_requested",
    occurredAt: "2026-08-23T00:00:00.000Z",
    payload: {
      dispatchId,
      runtimeSessionId,
      taskId,
      executionId: "execution-1",
      instanceId: "instance-1",
      agentId: "terra",
      definitionSnapshotRef: current.definitionSnapshotRef,
      attemptGroupId: dispatchId,
      attemptIndex: 0,
      reviewTarget: { kind: "decision", decisionId: "decision-1", digest: "a".repeat(64) },
    },
  } as unknown as Dispatch;
  const events = options.successor ? [event, options.successor] : [event];
  const projection = {
    read: () => ({ watermark: 1, sourceRevision: 1, packagePath: "tasks/task-1", snapshot: { task: { taskId } } }),
    readTaskRuntimeBatch: () => ({
      status: "ready",
      taskIds: [taskId],
      rows: [{ taskId, packagePath: "tasks/task-1", sessions: [current] }],
      watermark: 1,
      sourceRevision: 1,
    }),
    readLeaseIntervals: () => [],
    readEventWitness: () => null,
    readCanonicalEvents: () => ({ events: [] }),
    readTaskRelationsBySources: () => ({ rows: [] }),
    readRuntimeSession: () => current,
    readRuntimeDispatch: () => event,
    readRuntimeDispatches: () => events,
    readRuntimeDispatchById: (id: string) => {
      const event = events.find((e) => e.payload.dispatchId === id);
      return event ? { event } : null;
    },
    readRuntimeDispatchByResumeSource: () => (options.successor ? { event: options.successor } : null),
    readRuntimeDispatchesBySession: () => [{ event }],
    readRuntimeDispatchesByAttemptGroup: () => events.map((event) => ({ event })),
    readRuntimeSessionEvents: () =>
      options.metrics
        ? [
            {
              schema: "agent-runtime-event/v1",
              type: "runtime_session_outcome_observed",
              payload: { runtimeMetrics: options.metrics },
            },
          ]
        : [],
    readDocument: (path: string) => ({
      document:
        options.archive && path.endsWith(".json")
          ? { body: JSON.stringify({ schema: "runtime-dispatch/v1", ...options.archive }) }
          : null,
    }),
  } as unknown as TaskProjection;
  return { projection, event, rows: () => readTaskDispatches({ projection, taskId }).dispatches };
}

test("accepted liveness and terminal evidence determine public dispatch status without a local stream", () => {
  for (const [liveness, outcome, expected] of [
    ["live", null, "running"],
    ["exited", null, "unknown"],
    ["unknown", null, "unknown"],
    ["stale", null, "unknown"],
    ["live", "failed", "failed"],
    ["exited", "cancelled", "cancelled"],
    ["exited", "unknown", "unknown"],
  ] as const) {
    const row = fixture(session(liveness, outcome)).rows()[0]!;
    assert.equal(row.status, expected);
    assert.equal(row.eventStreamRef, null);
    assert.equal(taskDispatchRowsSettled([row]), outcome !== null);
  }
});

test("public dispatch, session group and attempt chain queries tolerate a filesystem trap", (t) => {
  const f = fixture(session("live", null));
  for (const method of ["readFileSync", "openSync", "readdirSync", "statSync", "existsSync", "unlinkSync"] as const)
    t.mock.method(fs, method, () => {
      throw new Error(`public reader touched ${method}`);
    });
  syncBuiltinESMExports();
  try {
    assert.equal(f.rows().length, 1);
    assert.equal(
      readSessionGroupDispatches({ projection: f.projection, sessions: [session("live", null)], events: [f.event] })
        .length,
      1,
    );
    assert.equal(readRuntimeAttemptChain(runtimeSessionId, f.projection)?.attempts.length, 1);
    assert.deepEqual(readTaskDispatchSession(f.projection, taskId, dispatchId), { runtimeSessionId });
    assert.equal(readTaskDispatchSession(f.projection, "other-task", dispatchId), null);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("resume is derived from canonical provider identity and withdrawn by an accepted successor", () => {
  const f = fixture(session("exited", "failed"));
  assert.deepEqual(f.rows()[0]?.resume, { dispatchId, agentId: "terra" });
  const successor = {
    ...f.event,
    payload: {
      ...f.event.payload,
      dispatchId: "dispatch_fedcba987654321001234567",
      runtimeSessionId: "runtime-2",
      attemptIndex: 1,
    },
  };
  const resumed = fixture(session("exited", "failed"), { successor });
  assert.equal(resumed.rows()[0]?.resume, undefined);
  assert.equal(resumed.rows()[0]?.nextDispatchId, successor.payload.dispatchId);
  assert.equal(resumed.rows()[0]?.fallbackState, "dispatched");
  assert.equal(readRuntimeAttemptChain(runtimeSessionId, resumed.projection)?.attempts.length, 2);
});

test("only accepted outcome metrics appear and unknown live telemetry stays absent", () => {
  assert.equal(fixture().rows()[0]?.metrics, undefined);
  const metrics = {
    inputTokens: 40,
    cacheReadTokens: 10,
    outputTokens: 20,
    totalTokens: 60,
    toolCallCount: 2,
    usageUnavailable: false,
  };
  assert.deepEqual(fixture(session("exited", "succeeded"), { metrics }).rows()[0]?.metrics, {
    ...metrics,
    compacted: null,
  });
});

test("canonical archive preserves result, artifact, delegation and provider quota evidence", () => {
  const resultRef = `artifact:runtime-result/sha256/${"a".repeat(64)}`;
  const row = fixture(session("exited", null), {
    archive: {
      resultRef,
      exitCode: 1,
      outcome: "failed",
      classification: "provider_quota",
      reason: "quota exhausted",
      parentRuntimeSessionId: "runtime-parent",
      delegatedByAgentId: "leader",
      providerSessionId: "provider-session",
    },
  }).rows()[0]!;
  assert.equal(row.resultRef, resultRef);
  assert.equal(row.status, "failed");
  assert.equal(row.parentRuntimeSessionId, "runtime-parent");
  assert.equal(row.delegatedByAgentId, "leader");
  assert.equal(row.dispatchPath, `tasks/task-1/artifacts/dispatches/${dispatchId}.json`);
  assert.equal(row.reportPath, undefined);
  assert.match(row.nextAction!, /--resume-dispatch/u);
  assert.equal(row.reviewTarget?.kind, "decision");
});

test("dispatch rows expose successful advisory fields from the center-local annotation store", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-dispatch-advisory-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = openDecisionAnnotationStore(rootDir),
    advisory = {
      pointId: "dispatch-stop-reason",
      questionVersion: "pilot2-choice-v2",
      selected: "environment_unavailable",
      distribution: { environment_unavailable: 0.9, insufficient_information: 0.1 },
      options: [
        { id: "environment_unavailable", text: "Environment unavailable" },
        { id: "insufficient_information", text: "Insufficient information" },
      ],
      provider: {
        providerId: "dp-openrouter-mercury",
        vendor: "openrouter" as const,
        requestedModel: "model-a",
        resolvedModel: "model-a",
        modelVersion: null,
        providerRoute: null,
      },
      usage: { inputTokens: 12, outputTokens: 3, reportedCost: null },
      latencyMs: 24,
    };
  await store.reserve({
    key: "advisory-key",
    pointId: advisory.pointId,
    questionVersion: advisory.questionVersion,
    bindingDigest: "b".repeat(64),
    event: "dispatch.settled",
    show: ["task.dispatches"],
    dispatchId,
    subjectRef: `dispatch/${dispatchId}`,
    now: "2026-10-19T00:00:00.000Z",
    egress: {
      subjectRef: `dispatch/${dispatchId}`,
      dispatchId,
      pointId: advisory.pointId,
      fields: ["report.body"],
      providerId: advisory.provider.providerId,
      model: advisory.provider.requestedModel,
      sentAt: "2026-10-19T00:00:00.000Z",
      inputDigest: "c".repeat(64),
    },
  });
  await store.succeed("advisory-key", advisory, "2026-10-19T00:00:01.000Z");

  const row = readTaskDispatches({ projection: fixture(session("exited", "succeeded")).projection, taskId, rootDir })
    .dispatches[0]!;
  assert.deepEqual(row.advisories, [advisory]);
});

test("normal exit with a result is stopped rather than unknown", () => {
  assert.equal(
    fixture(
      session("exited", "stopped", { exitCode: 0, resultRef: "artifact:runtime-result/sha256/" + "a".repeat(64) }),
    ).rows()[0]?.status,
    "stopped",
  );
});

// A delivered submission outranks the settlement-time "stopped" verdict: the submit boundary
// freezes what the delivery actually was — a commit cut or frozen artifacts — so a document-only
// task never renders "stopped without a delivery" once its execution submitted.
test("a stopped dispatch whose execution delivered is read back succeeded", () => {
  for (const submission of [
    { commitSha: null, artifacts: [{ path: "artifacts/report.md", revision: 42, blobSha256: "a".repeat(64) }] },
    { commitSha: "b".repeat(40), artifacts: [] },
  ] as const) {
    const f = fixture(
      session("exited", "stopped", { exitCode: 0, resultRef: "artifact:runtime-result/sha256/" + "a".repeat(64) }),
    );
    const projection = {
      ...f.projection,
      read: () => ({
        snapshot: { task: { taskId }, executions: [{ executionId: "execution-1", submission }] },
        packagePath: "tasks/task-1",
      }),
    } as unknown as TaskProjection;
    const rows = readTaskDispatches({ projection, taskId }).dispatches;
    assert.equal(rows[0]?.status, "succeeded");
    assert.equal(taskDispatchesOutcome(rows, new Map()).outcome, "succeeded");
  }
});

// No submission, or another execution's submission, never witnesses this round.
test("a stopped dispatch without its own accepted submission stays stopped", () => {
  for (const executions of [
    [],
    [{ executionId: "execution-1", submission: null }],
    [{ executionId: "other-execution", submission: { commitSha: "b".repeat(40), artifacts: [] } }],
  ] as const) {
    const f = fixture(
      session("exited", "stopped", { exitCode: 0, resultRef: "artifact:runtime-result/sha256/" + "a".repeat(64) }),
    );
    const projection = {
      ...f.projection,
      read: () => ({ snapshot: { task: { taskId }, executions }, packagePath: "tasks/task-1" }),
    } as unknown as TaskProjection;
    assert.equal(readTaskDispatches({ projection, taskId }).dispatches[0]?.status, "stopped");
  }
});

test("a stopped dispatch with the same empty-cut accepted submission is read back succeeded", () => {
  const f = fixture(
    session("exited", "stopped", { exitCode: 0, resultRef: "artifact:runtime-result/sha256/" + "a".repeat(64) }),
  );
  const projection = {
    ...f.projection,
    read: () => ({
      snapshot: {
        task: { taskId },
        executions: [{ executionId: "execution-1", submission: { commitSha: null, artifacts: [] } }],
      },
      packagePath: "tasks/task-1",
    }),
  } as unknown as TaskProjection;
  const rows = readTaskDispatches({ projection, taskId }).dispatches;
  assert.equal(rows[0]?.status, "succeeded");
  assert.equal(taskDispatchesOutcome(rows, new Map()).outcome, "succeeded");
});

test("stopped dispatch is shown as blocked only from a structured task state", () => {
  const f = fixture(
    session("exited", "stopped", { exitCode: 0, resultRef: "artifact:runtime-result/sha256/" + "a".repeat(64) }),
  );
  const projection = {
    ...f.projection,
    read: () => ({ snapshot: { task: { taskId, status: "blocked" } }, packagePath: "tasks/task-1" }),
    readLeaseIntervals: () => [blockLease()],
    readCanonicalEvents: () => ({ events: [blockedRelease()] }),
  } as unknown as TaskProjection;
  assert.equal(readTaskDispatches({ projection, taskId }).dispatches[0]?.status, "blocked");
});

test("point dispatch lookup cannot attribute a canonical dispatch to a different task", () => {
  const f = fixture();
  assert.equal(readTaskDispatchSession(f.projection, "wrong-task", dispatchId), null);
  assert.equal(readTaskDispatchSession(f.projection, taskId, "missing"), null);
});

test("missing task and missing package are reported explicitly", () => {
  for (const task of [null, { taskId }]) {
    const projection = {
      ...fixture().projection,
      readTaskRuntimeBatch: () => ({
        status: "ready",
        taskIds: [taskId],
        rows: [{ taskId, packagePath: null, sessions: [] }],
        watermark: 1,
        sourceRevision: 1,
      }),
      read: () => ({ snapshot: { task }, packagePath: null, watermark: 1, sourceRevision: 1 }),
    } as unknown as TaskProjection;
    assert.throws(() => readTaskDispatches({ projection, taskId }), /Task task-1/u);
  }
});

test("accepted dispatch before session binding is visible without a live index", () => {
  const f = fixture();
  const projection = {
    ...f.projection,
    readTaskRuntimeBatch: () => ({
      status: "ready",
      taskIds: [taskId],
      rows: [{ taskId, packagePath: "tasks/task-1", sessions: [] }],
      watermark: 1,
      sourceRevision: 1,
    }),
  } as unknown as TaskProjection;
  const row = readTaskDispatches({ projection, taskId }).dispatches[0]!;
  assert.equal(row.dispatchId, dispatchId);
  assert.equal(row.status, "unknown");
});

test("a dispatch without canonical attempt-group attribution does not advertise an empty chain", () => {
  const f = fixture(),
    { attemptGroupId: _group, ...payload } = f.event.payload;
  const projection = {
    ...f.projection,
    readRuntimeDispatchesBySession: () => [{ event: { ...f.event, payload } }],
  } as TaskProjection;
  assert.equal(readRuntimeAttemptChain(runtimeSessionId, projection), undefined);
});

function blockLease() {
  return {
    executionId: "execution-1",
    acquiredRevision: 10,
    releasedRevision: 20,
    holder: { actor: { executor: { id: `runtime-session:${runtimeSessionId}` } } },
    leaseExpiresAt: "2026-08-24T00:00:00.000Z",
  };
}

function blockedRelease() {
  return {
    schema: "task-event/v1",
    type: "lease_released",
    actor: { executor: { id: `runtime-session:${runtimeSessionId}` } },
    payload: { task: { status: "blocked" }, mutation: { fields: ["status"] } },
  };
}

// dec_614F7BBB18C8687E7EFC72173D/CH2: prose, other executions and stale awaits cannot declare this stop blocked.
test("stopped dispatch awaits must be active and written within its lease interval", () => {
  const f = fixture(session("exited", "stopped"));
  for (const sample of [
    { state: "active", revision: 15, executor: `runtime-session:${runtimeSessionId}`, expected: "blocked" },
    { state: "retired", revision: 15, executor: `runtime-session:${runtimeSessionId}`, expected: "stopped" },
    { state: "active", revision: 9, executor: `runtime-session:${runtimeSessionId}`, expected: "stopped" },
    { state: "active", revision: 21, executor: `runtime-session:${runtimeSessionId}`, expected: "stopped" },
    { state: "active", revision: null, executor: `runtime-session:${runtimeSessionId}`, expected: "stopped" },
    { state: "active", revision: 15, executor: "owner:register-awaits", expected: "blocked" },
  ]) {
    const projection = {
      ...f.projection,
      readLeaseIntervals: () => [blockLease()],
      readTaskRelationsBySources: () => ({
        rows: [{ state: sample.state, sourceRef: `task/${taskId}`, workspaceRevision: sample.revision }],
      }),
      readEventWitness: () => ({
        actor: { executor: { id: sample.executor } },
        occurredAt: "2026-08-23T12:00:00.000Z",
      }),
    } as unknown as TaskProjection;
    assert.equal(readTaskDispatches({ projection, taskId }).dispatches[0]?.status, sample.expected);
  }
  const expired = {
    ...f.projection,
    readLeaseIntervals: () => [blockLease()],
    readTaskRelationsBySources: () => ({
      rows: [{ state: "active", sourceRef: `task/${taskId}`, workspaceRevision: 15 }],
    }),
    readEventWitness: () => ({ occurredAt: "2026-08-25T00:00:00.000Z" }),
  } as unknown as TaskProjection;
  assert.equal(readTaskDispatches({ projection: expired, taskId }).dispatches[0]?.status, "stopped");
  const unrelated = {
    ...f.projection,
    read: () => ({ snapshot: { task: { taskId, status: "blocked" } }, packagePath: "tasks/task-1" }),
  } as unknown as TaskProjection;
  assert.equal(readTaskDispatches({ projection: unrelated, taskId }).dispatches[0]?.status, "stopped");
  const supersededLease = {
    ...unrelated,
    readCanonicalEvents: () => ({ events: [blockedRelease()] }),
    readLeaseIntervals: () => [
      blockLease(),
      { ...blockLease(), holder: { actor: { executor: { id: "runtime-session:next-worker" } } } },
    ],
  } as unknown as TaskProjection;
  assert.equal(readTaskDispatches({ projection: supersededLease, taskId }).dispatches[0]?.status, "stopped");
  const unchangedStatus = {
    ...unrelated,
    readLeaseIntervals: () => [blockLease()],
    readCanonicalEvents: () => ({
      events: [{ ...blockedRelease(), payload: { task: { status: "blocked" }, mutation: { fields: [] } } }],
    }),
  } as unknown as TaskProjection;
  assert.equal(readTaskDispatches({ projection: unchangedStatus, taskId }).dispatches[0]?.status, "stopped");
});

test("member dispatch reads page an executor's newest rows with window groups and full-history totals", () => {
  const sessions = {
      "runtime-terra-1": session("exited", "succeeded", {
        runtimeSessionId: "runtime-terra-1",
        taskBindings: [
          { taskId: "task-a", executionId: "execution-dispatch_member_old", boundAt: "2026-08-23T00:00:00.000Z" },
        ],
      }),
      "runtime-terra-2": session("exited", "failed", {
        runtimeSessionId: "runtime-terra-2",
        taskBindings: [
          { taskId: "task-b", executionId: "execution-dispatch_member_new", boundAt: "2026-08-24T00:00:00.000Z" },
        ],
        lastObservedAt: "2026-08-24T00:00:00.000Z",
      }),
    } as Record<string, RuntimeSession>,
    dispatchEvent = (dispatchId: string, runtimeSessionId: string, taskId: string, startedAt: string) =>
      ({
        schema: "agent-runtime-event/v1",
        type: "runtime_dispatch_requested",
        occurredAt: startedAt,
        payload: {
          dispatchId,
          runtimeSessionId,
          taskId,
          executionId: `execution-${dispatchId}`,
          instanceId: "instance-1",
          agentId: "terra",
          definitionSnapshotRef: "artifact:runtime-definition/test",
          attemptGroupId: dispatchId,
          attemptIndex: 0,
          startedAt,
        },
      }) as unknown as Dispatch;
  const older = dispatchEvent("dispatch_member_old", "runtime-terra-1", "task-a", "2026-08-23T00:00:00.000Z"),
    newer = dispatchEvent("dispatch_member_new", "runtime-terra-2", "task-b", "2026-08-24T00:00:00.000Z"),
    memberPage = {
      rows: [newer, older],
      truncated: true,
      sessions: [
        { runtimeSessionId: "runtime-terra-1", taskIds: ["task-a"], latestDecisionId: null },
        { runtimeSessionId: "runtime-terra-2", taskIds: ["task-b"], latestDecisionId: null },
      ],
    };
  const projection = {
    read: () => ({ snapshot: { task: { taskId } }, packagePath: "tasks/task-1" }),
    readDocument: () => ({ document: null }),
    readRuntimeSessionEvents: () => [],
    readRuntimeDispatchByResumeSource: () => null,
    readRuntimeDispatchesByAttemptGroup: () => [],
    readLeaseIntervals: () => [],
    readEventWitness: () => null,
    readCanonicalEvents: () => ({ events: [] }),
    readTaskRelationsBySources: () => ({ rows: [] }),
    readTaskRuntimeBatch: ({ taskIds }: { readonly taskIds: readonly string[] }) => ({
      status: "ready",
      taskIds,
      rows: taskIds.map((taskId) => ({
        taskId,
        packagePath: `tasks/${taskId}`,
        sessions: [],
        title: `Title ${taskId}`,
      })),
      watermark: 1,
      sourceRevision: 1,
    }),
    listEntities: () => [],
    readCut: () => ({ status: "ready", watermark: 1, sourceRevision: 1 }),
    readRuntimeSession: (id: string) => sessions[id] ?? null,
    readRuntimeDispatchesByMember: (query: {
      readonly agentId?: string;
      readonly squadId?: string;
      readonly limit: number;
    }) => {
      assert.equal(query.agentId ?? query.squadId, "terra");
      return query.limit === 1 ? { rows: [newer], truncated: true, sessions: memberPage.sessions } : memberPage;
    },
  } as unknown as TaskProjection;
  const page = readTaskDispatches({ projection, agentId: "terra", limit: 2 });
  assert.deepEqual(
    page.dispatches.map((row) => row.dispatchId),
    ["dispatch_member_new", "dispatch_member_old"],
  );
  assert.equal(page.dispatches[0]?.agentId, "terra");
  assert.equal(page.dispatches[0]?.taskTitle ?? null, null);
  assert.equal(page.truncated, true);
  assert.deepEqual(page.totals, { groups: 2, sessions: 2 });
  assert.deepEqual(
    page.groups.map((group) => [group.key, group.label, group.sessionCount]),
    [
      ["task-b", "Title task-b", 1],
      ["task-a", "Title task-a", 1],
    ],
  );
  assert.deepEqual(page.taskLabels, [
    { taskId: "task-b", title: "Title task-b" },
    { taskId: "task-a", title: "Title task-a" },
  ]);
  const first = readTaskDispatches({ projection, agentId: "terra", limit: 1 });
  assert.deepEqual(
    first.dispatches.map((row) => row.dispatchId),
    ["dispatch_member_new"],
  );
  assert.equal(first.truncated, true);
  assert.deepEqual(validateDaemonTaskDispatches(page), []);
  assert.notDeepEqual(validateDaemonTaskDispatches({ ...page, totals: { groups: "many", sessions: 1326 } }), []);
});

// Member rows arrive newest-first, so a last-write-wins startedAt map keeps the session's
// oldest page dispatch; a binding whose latest round is another task must fall back to the
// session's newest dispatch, same as the full-history sessionGroups path.
test("a member page window group falls back to the session's newest dispatch, not its oldest", () => {
  const multiBinding = session("exited", "succeeded", {
      runtimeSessionId: "runtime-terra-1",
      taskBindings: [
        { taskId: "task-a", executionId: "execution-dispatch_member_old", boundAt: "2026-08-23T00:00:00.000Z" },
        { taskId: "task-b", executionId: "execution-dispatch_member_new", boundAt: "2026-08-24T00:00:00.000Z" },
      ],
    }),
    dispatchEvent = (dispatchId: string, taskId: string, startedAt: string) =>
      ({
        schema: "agent-runtime-event/v1",
        type: "runtime_dispatch_requested",
        occurredAt: startedAt,
        payload: {
          dispatchId,
          runtimeSessionId: "runtime-terra-1",
          taskId,
          executionId: `execution-${dispatchId}`,
          instanceId: "instance-1",
          agentId: "terra",
          definitionSnapshotRef: "artifact:runtime-definition/test",
          attemptGroupId: dispatchId,
          attemptIndex: 0,
          startedAt,
        },
      }) as unknown as Dispatch;
  const older = dispatchEvent("dispatch_member_old", "task-a", "2026-08-23T00:00:00.000Z"),
    newer = dispatchEvent("dispatch_member_new", "task-b", "2026-08-24T00:00:00.000Z"),
    projection = {
      read: () => ({ snapshot: { task: { taskId } }, packagePath: "tasks/task-1" }),
      readDocument: () => ({ document: null }),
      readRuntimeSessionEvents: () => [],
      readRuntimeDispatchByResumeSource: () => null,
      readRuntimeDispatchesByAttemptGroup: () => [],
      readLeaseIntervals: () => [],
      readEventWitness: () => null,
      readCanonicalEvents: () => ({ events: [] }),
      readTaskRelationsBySources: () => ({ rows: [] }),
      readTaskRuntimeBatch: ({ taskIds }: { readonly taskIds: readonly string[] }) => ({
        status: "ready",
        taskIds,
        rows: taskIds.map((taskId) => ({
          taskId,
          packagePath: `tasks/${taskId}`,
          sessions: [],
          title: `Title ${taskId}`,
        })),
        watermark: 1,
        sourceRevision: 1,
      }),
      listEntities: () => [],
      readCut: () => ({ status: "ready", watermark: 1, sourceRevision: 1 }),
      readRuntimeSession: (id: string) => (id === "runtime-terra-1" ? multiBinding : null),
      readRuntimeDispatchesByMember: () => ({
        rows: [newer, older],
        truncated: false,
        sessions: [{ runtimeSessionId: "runtime-terra-1", taskIds: ["task-a", "task-b"], latestDecisionId: null }],
      }),
    } as unknown as TaskProjection;
  const page = readTaskDispatches({ projection, agentId: "terra", limit: 2 });
  assert.deepEqual(
    page.groups.map((group) => [group.key, group.latestRound?.startedAt]),
    [
      ["task-a", "2026-08-24T00:00:00.000Z"],
      ["task-b", "2026-08-24T00:00:00.000Z"],
    ],
  );
});

test("member dispatch payloads accept one selector and a bounded limit at both boundaries", () => {
  const context = {
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      requiredCellText: (value: unknown, field: string) => {
        if (typeof value !== "string" || value === "")
          throw Object.assign(new Error(`${field} must be non-empty text`), { code: "invalid_command" });
        return value;
      },
    } as unknown as RepoCellApiContext,
    parse = (payload: Readonly<Record<string, unknown>>) => taskDispatchesPayloadFromCell(context, payload);
  assert.deepEqual(parse({ agentId: "terra", limit: 50 }), { agentId: "terra", limit: 50 });
  assert.deepEqual(parse({ squadId: "squad-x", limit: 500 }), { squadId: "squad-x", limit: 500 });
  for (const payload of [
    { agentId: "terra", squadId: "squad-x", limit: 50 },
    { agentId: "terra" },
    { agentId: "terra", limit: 0 },
    { agentId: "terra", limit: 501 },
    { agentId: "terra", limit: 50, taskIds: ["task-a"] },
    { agentId: "", limit: 50 },
  ])
    assert.throws(() => parse(payload), /must be non-empty text|Task dispatch member reads/);
});

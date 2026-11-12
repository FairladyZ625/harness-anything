// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { DispatchLifecycleQuery, DispatchLifecycleRead } from "@harness-anything/kernel";
import { makeRuntimeSpawner } from "../src/runtime-spawn.ts";
import { cancelRuntime } from "../src/runtime-spawn-control.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { RuntimeBinding } from "../src/runtime-spawn-types.ts";
import { definition, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";

const binding: RuntimeBinding = {
  actor: { principal: { personId: "owner" }, executor: { kind: "agent", id: "operator" } },
  source: { kind: "node", nodeId: "node-a" },
};
const runtimeSessionId = "runtime_111111111111111111111111";
const dispatchId = "dispatch_111111111111111111111111";
const now = "2026-11-08T08:00:00.000Z";

function fixture(t: test.TestContext) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-missing-dispatch-ruling-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const session = {
    runtimeSessionId,
    instanceId: definition.instanceId,
    providerSessionId: null,
    liveness: "live" as const,
    outcome: null as "unknown" | null,
  };
  const owner = {
    ...binding,
    payload: { dispatchId },
    instanceId: definition.instanceId,
    processGroupPid: null as number | null,
  };
  const published: Array<{
    type: string;
    payload: Record<string, unknown>;
    opId: string;
    actor: RuntimeBinding["actor"];
    body?: string;
  }> = [];
  const terminationAttempts = { terminate: 0, terminateTree: 0 };
  let rulingResolved = false;
  const blockedLifecycleRead = async (): Promise<DispatchLifecycleRead> => ({
    status: "ready",
    watermark: 1,
    sourceRevision: 1,
    rows: [
      {
        attemptGroupId: "missing-dispatch-group",
        groupPhase: "settling",
        attempt: {
          dispatchId,
          runtimeSessionId,
          instanceId: definition.instanceId,
          fence: { owner: "node:node-a", verified: true, token: 1, epoch: null },
          reservation: {
            reservationId: `${definition.instanceId}/${dispatchId}`,
            instanceId: definition.instanceId,
            owner: "node:node-a",
          },
          task: null,
          workspaceRef: null,
          phase: "settling",
          process: "unknown",
          stopProof: "unproven",
          outcome: null,
          admittedRevision: 1,
          eventIds: ["missing-dispatch-event"],
        },
        successor: { admissible: false, dueAt: null },
        ruling: null,
        delivery: { status: "unregistered", targetRef: null, targetDigest: null, registeredRevision: null },
        revision: 1,
        policy: {
          attemptSettled: false,
          groupSettled: false,
          capacity: "held",
          capacityDisposition: "recovering",
          successorAdmissible: false,
          canResolveRuling: false,
          canRecover: false,
          blockerCode: "runtime_recovery_pending",
        },
      } as never,
    ],
    nextCursor: null,
  });
  const context = {
    input: {
      rootDir,
      repoId: "missing-dispatch-ruling",
      runtimeNode: { nodeId: "node-a" },
      now: () => now,
      remote: {
        readRuntimeSession: async () => session,
        readRuntimeSessions: async () => [session],
        readDispatchLifecycle: async (query: DispatchLifecycleQuery) =>
          !rulingResolved &&
          ((query.by === "active" && query.instanceId === definition.instanceId) ||
            (query.by === "session" && query.runtimeSessionId === runtimeSessionId))
            ? blockedLifecycleRead()
            : { status: "ready", watermark: 1, sourceRevision: 1, rows: [], nextCursor: null },
        readRuntimeDispatch: async () => owner,
      },
      reclaimRuntimeTempDirectory: () => assert.fail("a ruling is not a process stop proof or cleanup permission"),
      onAttemptTerminal: async () => assert.fail("a ruling cannot release a task lease without stop proof"),
    },
    processes: new Map(),
    exiting: new Set(),
    ownsModelSlot: () => false,
    publishRuntimeEvent: async (
      type: string,
      payload: Record<string, unknown>,
      opId: string,
      author: RuntimeBinding,
      body?: string,
    ) => {
      published.push({ type, payload, opId, actor: author.actor, body });
      if (type === "runtime_session_outcome_observed") session.outcome = payload.outcome as "unknown";
      if (payload.reasonCode === "ruling_resolved") rulingResolved = true;
    },
    controlReceipt: (opId: string, id: string, detail: string) => ({
      ok: true,
      outcome: "applied",
      opId,
      runtimeSessionId: id,
      detail,
    }),
  } as unknown as RuntimeSpawnerContext;
  return { rootDir, context, session, owner, published, terminationAttempts };
}

test("owner ruling closes a live session with no local owner, dispatch stream or recorded group, without stop proof", async (t) => {
  const f = fixture(t);
  await assert.rejects(cancelRuntime(f.context, { runtimeSessionId }, binding), {
    code: "runtime_process_group_unproven",
  });
  const reason = "Owner inspected the host and abandons the unrecoverable dispatch.";
  const receipt = await cancelRuntime(f.context, { runtimeSessionId, ruling: reason }, binding);
  assert.equal(receipt.detail, "ruling_resolved");
  assert.equal(f.session.outcome, "unknown");
  assert.equal(f.session.liveness, "live", "the ruling makes no physical exit observation");
  assert.deepEqual(
    f.published.map((event) => event.type),
    ["runtime_session_outcome_observed"],
  );
  const event = f.published[0]!;
  assert.equal(event.payload.reasonCode, "ruling_resolved");
  assert.equal(event.payload.dispatchId, dispatchId);
  assert.equal(event.payload.endedAt, now);
  assert.deepEqual(event.actor, binding.actor);
  assert.deepEqual(JSON.parse(event.body!), {
    schema: "runtime-ruling-resolution/v1",
    runtimeSessionId,
    dispatchId,
    from: "settling",
    to: "closed",
    event: "ruling_resolved",
    disposition: "abandoned_unproven",
    processStop: "unproven",
    actor: binding.actor,
    resolvedAt: now,
    reason,
  });
  await cancelRuntime(f.context, { runtimeSessionId, ruling: reason }, binding);
  assert.equal(f.published.length, 1, "repeated resolution cannot append a second terminal event");
});

for (const condition of [
  "stream",
  "recorded-group",
  "active-owner",
  "exiting-owner",
  "slot-owner",
  "foreign-person",
  "foreign-node",
  "blank-ruling",
] as const) {
  test(`owner ruling refuses ${condition} and makes no terminal write`, async (t) => {
    const f = fixture(t);
    if (condition === "stream")
      openDispatchStream(f.rootDir, {
        dispatchId,
        runtimeSessionId,
        taskId: null,
        executionId: null,
        instanceId: definition.instanceId,
        startedAt: now,
        binding,
      });
    if (condition === "recorded-group") f.owner.processGroupPid = process.pid;
    if (condition === "active-owner")
      f.context.processes.set(runtimeSessionId, {
        process: {
          terminate: () => {
            f.terminationAttempts.terminate += 1;
          },
          terminateTree: async () => {
            f.terminationAttempts.terminateTree += 1;
          },
        },
      } as never);
    if (condition === "exiting-owner") f.context.exiting.add(runtimeSessionId);
    const context = condition === "slot-owner" ? { ...f.context, ownsModelSlot: () => true } : f.context;
    const author =
      condition === "foreign-person"
        ? { ...binding, actor: { principal: { personId: "other" }, executor: null } }
        : condition === "foreign-node"
          ? { ...binding, source: { kind: "node" as const, nodeId: "node-b" } }
          : binding;
    const expected = condition.startsWith("foreign-")
      ? "execution_scope_mismatch"
      : condition === "blank-ruling"
        ? "invalid_runtime_ruling"
        : "runtime_ruling_not_allowed";
    await assert.rejects(
      cancelRuntime(
        context,
        { runtimeSessionId, ruling: condition === "blank-ruling" ? "  " : "Abandon dispatch" },
        author,
      ),
      { code: expected },
    );
    assert.deepEqual(f.published, []);
    if (condition === "active-owner") assert.deepEqual(f.terminationAttempts, { terminate: 0, terminateTree: 0 });
  });
}

for (const mission of ["implement", "review"] as const) {
  test(`failed recovery retains its instance but permits another ${mission} admission`, async (t) => {
    const f = fixture(t),
      ports = scheduleRuntimePorts();
    const healthyId = "healthy-instance";
    const admitted = Object.assign(new Error("healthy instance reached launch preparation"), {
      code: "fixture_admitted",
    });
    const diagnostics: unknown[] = [];
    const preparedInstances: string[] = [];
    const spawner = makeRuntimeSpawner({
      rootDir: f.rootDir,
      repoId: "missing-dispatch-ruling",
      daemonGeneration: 1,
      runtimeNode: { nodeId: "node-a" },
      runtimeDaemonRoute: {
        userRoot: path.join(f.rootDir, ".user"),
        daemonId: "test",
        endpoint: "/tmp/runtime-missing-dispatch-ruling.sock",
      },
      now: () => now,
      stream: { publish: () => ({}) as never },
      runtimeInstances: () => [...ports.runtimeInstances(), { ...ports.runtimeInstances()[0]!, instanceId: healthyId }],
      readSettings: () => ({ runtime: { allowedInstances: [definition.instanceId, healthyId] } }) as never,
      recordLifecycle: (event) => diagnostics.push(event),
      prepareLaunch: async (instanceId) => {
        preparedInstances.push(instanceId);
        throw admitted;
      },
      schedule: () => undefined,
      remote: {
        ...f.context.input.remote!,
        existing: async () => null,
        taskContext: async () => ({
          executionId: "execution-review",
          packageRoot: f.rootDir,
          worktree: null,
          mission: () => "Review the submitted cut.",
          planBody: null,
          riskTier: "low",
          riskTierFlowVersion: null,
          profileId: null,
          taskClass: "standard",
          causalContext: null,
          continuationContext: null,
          ownerReturnBody: null,
          reviewerNote: null,
        }),
        publish: async () => assert.fail("this probe stops at launch preparation"),
        archive: async () => ({ outcome: "applied" }),
      },
    });
    t.after(() => spawner.close());
    const recoveries = await spawner.adopt();
    assert.equal(recoveries[0]?.outcome, "failed");
    assert.ok(diagnostics.some((entry) => (entry as { event?: string }).event === "runtime_recovery_failed"));
    const action = {
      prompt: "admit",
      cwd: { scope: "repo-root" },
      dispatchKey: `probe-${mission}`,
      ...(mission === "review"
        ? {
            role: "reviewer",
            taskId: "task-review",
            executionId: "execution-review",
            reviewTarget: { kind: "task", taskId: "task-review", executionId: "execution-review", digest: "digest" },
          }
        : {}),
    };
    await assert.rejects(spawner.spawn({ ...action, runtimeInstanceId: definition.instanceId }, binding), {
      code: "runtime_recovery_pending",
    });
    await assert.rejects(spawner.spawn(action, binding), admitted);
    assert.deepEqual(preparedInstances, [healthyId]);
    assert.equal(f.session.outcome, null, "automatic selection leaves the failed session unresolved");
    await cancelRuntime(f.context, { runtimeSessionId, ruling: "Owner abandons the missing dispatch" }, binding);
    assert.equal(f.session.outcome, "unknown");
    await assert.rejects(
      spawner.spawn(
        { ...action, dispatchKey: `${action.dispatchKey}-after-ruling`, runtimeInstanceId: definition.instanceId },
        binding,
      ),
      admitted,
    );
    assert.deepEqual(preparedInstances, [healthyId, definition.instanceId]);
  });
}

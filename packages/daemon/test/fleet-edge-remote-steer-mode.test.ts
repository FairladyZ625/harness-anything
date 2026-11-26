// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  validateCurrentAgentRuntimeEvent,
  type RuntimeSession,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { openDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { steerRuntime } from "../src/daemon-host/runtime-spawn-control.ts";
import { createActiveRuntime } from "../src/daemon-host/runtime-spawn-active.ts";
import type { RuntimeSpawnerContext } from "../src/daemon-host/runtime-spawn-context.ts";
import { readRuntimeSteerVersion } from "../src/daemon-host/runtime-steer-target.ts";
import {
  createFleetEdgeRuntimeControlConsumer,
  extractRemoteControlRequest,
  type RemoteRuntimeControlEvent,
} from "../src/daemon-host/fleet-edge-runtime-control.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const actor = { principal: { personId: "person-owner" }, executor: null } as const;

function baseSession(runtimeSessionId = "runtime_aaaaaaaaaaaaaaaaaaaaaaaa"): RuntimeSession {
  return {
    runtimeSessionId,
    instanceId: "instance-1",
    installationId: "install-1",
    kindId: "codex",
    definitionSnapshotRef: "artifact:runtime-definition/sha256/" + "a".repeat(64),
    providerSessionId: "thread-1",
    transcriptRef: "provider:codex/thread-1",
    launchGeneration: 1,
    liveness: "live",
    attachable: true,
    taskBindings: [],
    outcome: null,
    exitCode: null,
    resultRef: null,
    lastObservedAt: "2026-11-21T02:00:00.000Z",
  };
}

function livenessSteerControlEvent(overrides: {
  readonly runtimeSessionId?: string;
  readonly dispatchId?: string;
  readonly controlRequestId?: string;
  readonly opId?: string;
  readonly targetNodeId?: string;
  readonly prompt?: string;
  readonly workspaceRevision?: number;
  readonly expected?: { readonly dispatchId?: string; readonly version?: number };
}): Extract<RemoteRuntimeControlEvent, { readonly type: "runtime_session_liveness_changed" }> {
  const runtimeSessionId = overrides.runtimeSessionId ?? "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
    controlRequestId = overrides.controlRequestId ?? "ctrl-steer-1",
    opId = overrides.opId ?? `op-steer-${runtimeSessionId}-${controlRequestId}`;
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-${opId}`,
    workspaceRevision: overrides.workspaceRevision ?? 11,
    opId,
    type: "runtime_session_liveness_changed",
    actor,
    source: "local",
    occurredAt: "2026-11-21T02:01:00.000Z",
    payload: {
      runtimeSessionId,
      liveness: "live",
      controlRequest: {
        action: "steer",
        controlRequestId,
        targetNodeId: overrides.targetNodeId ?? "node-a",
        dispatchId: overrides.dispatchId ?? "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
        prompt: overrides.prompt ?? "Pivot to verification.",
        ...(overrides.expected !== undefined ? { expected: overrides.expected } : {}),
      },
    },
  };
}

function makePagedReader(events: readonly RemoteRuntimeControlEvent[]) {
  const calls: Array<{ readonly sessionId: string; readonly afterRevision: number; readonly limit: number }> = [];
  const readControlEventsPage = async (
    runtimeSessionId: string,
    afterRevision: number,
    limit: number,
  ): Promise<readonly RemoteRuntimeControlEvent[]> => {
    calls.push({ sessionId: runtimeSessionId, afterRevision, limit });
    return events
      .filter((event) => event.payload.runtimeSessionId === runtimeSessionId && event.workspaceRevision > afterRevision)
      .sort((left, right) => left.workspaceRevision - right.workspaceRevision)
      .slice(0, limit);
  };
  return { calls, readControlEventsPage };
}

test("F-7C2A9E41: task-target steer on remote/edge dispatch never enqueues or spawns locally on center and forwards optional mode", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-f7c2a9e41-"));
  t.after(() => removeTempRepository(rootDir));

  const taskId = "task_a10000000000000000000001",
    codexDispatchId = "dispatch_a10000000000000000000001",
    codexSessionId = "runtime_a10000000000000000000001",
    agyDispatchId = "dispatch_a20000000000000000000002",
    agySessionId = "runtime_a20000000000000000000002",
    exitedDispatchId = "dispatch_a30000000000000000000003",
    exitedSessionId = "runtime_a30000000000000000000003";

  const makeRemoteDispatchEvent = (input: {
    readonly dispatchId: string;
    readonly runtimeSessionId: string;
    readonly kindId: "codex" | "agy";
  }) => ({
    schema: "agent-runtime-event/v1" as const,
    eventId: `evt-${input.dispatchId}`,
    workspaceRevision: 10,
    opId: `op-${input.dispatchId}`,
    type: "runtime_dispatch_requested" as const,
    actor,
    source: { kind: "node" as const, nodeId: "node-edge-1" },
    occurredAt: "2026-11-27T00:00:00.000Z",
    payload: {
      dispatchId: input.dispatchId,
      runtimeSessionId: input.runtimeSessionId,
      taskId,
      instanceId: `inst-${input.kindId}`,
      installationId: `install-${input.kindId}`,
      kindId: input.kindId,
      dispatchKey: `key-${input.dispatchId}`,
      definitionSnapshotRef: "artifact:runtime-definition/sha256/" + "a".repeat(64),
      definitionSnapshot: {
        schema: "agent-definition-snapshot/v1" as const,
        configVersion: 1,
        instanceId: `inst-${input.kindId}`,
        installationId: `install-${input.kindId}`,
        kindId: input.kindId,
        providerId: input.kindId === "codex" ? "openai" : "google",
        model: input.kindId === "codex" ? "gpt-5.6-sol" : "gemini-4-neon",
        reasoningEffort: "high",
        endpointKind: "official" as const,
        baseUrlHash: null,
        authMode: "subscription" as const,
      },
      agentId: "sol-worker",
      role: "worker",
    },
  });

  const dispatches = new Map([
    [
      codexDispatchId,
      makeRemoteDispatchEvent({ dispatchId: codexDispatchId, runtimeSessionId: codexSessionId, kindId: "codex" }),
    ],
    [
      agyDispatchId,
      makeRemoteDispatchEvent({ dispatchId: agyDispatchId, runtimeSessionId: agySessionId, kindId: "agy" }),
    ],
    [
      exitedDispatchId,
      makeRemoteDispatchEvent({ dispatchId: exitedDispatchId, runtimeSessionId: exitedSessionId, kindId: "codex" }),
    ],
  ]);

  let latestDispatchId = codexDispatchId;
  const publishedEvents: Array<{ readonly type: string; readonly payload: Record<string, unknown> }> = [];
  const storeAppends: unknown[] = [];
  const scheduledCallbacks: unknown[] = [];
  const localContinuationSpawns: unknown[] = [];

  const projection = {
    readLatestRuntimeDispatchesByTaskIds: (ids: readonly string[]) =>
      ids.includes(taskId) ? [dispatches.get(latestDispatchId)!] : [],
    readTaskExists: (id: string) => id === taskId,
    readRuntimeDispatchById: (dispatchId: string) => {
      const event = dispatches.get(dispatchId);
      return event ? { event } : null;
    },
    readRuntimeDispatch: (sessionId: string) =>
      [...dispatches.values()].find((event) => event.payload.runtimeSessionId === sessionId) ?? null,
    readRuntimeSession: (sessionId: string) => {
      if (sessionId === codexSessionId) return baseSession(codexSessionId);
      if (sessionId === agySessionId) return { ...baseSession(agySessionId), kindId: "agy" as const };
      if (sessionId === exitedSessionId)
        return { ...baseSession(exitedSessionId), liveness: "exited" as const, outcome: "succeeded" as const };
      return null;
    },
    readDispatchLifecycle: (query: { readonly runtimeSessionId?: string }) => {
      const sessionId = query.runtimeSessionId ?? codexSessionId;
      const isExited = sessionId === exitedSessionId;
      const dispatch = [...dispatches.values()].find((event) => event.payload.runtimeSessionId === sessionId)!;
      return {
        status: "ready" as const,
        watermark: 20,
        sourceRevision: 20,
        rows: [
          {
            attempt: {
              dispatchId: dispatch.payload.dispatchId,
              runtimeSessionId: sessionId,
              kindId: dispatch.payload.kindId,
              phase: isExited ? "settled" : "running",
              process: isExited ? "exited" : "alive",
              stopProof: isExited ? "proven_stopped" : "none",
              outcome: isExited ? "succeeded" : null,
              fence: { verified: true, owner: "node:node-edge-1" },
            },
            policy: {
              processAlive: !isExited,
              canSteer: !isExited,
              attemptSettled: isExited,
              groupSettled: isExited,
            },
            controlLeafDispatchId: dispatch.payload.dispatchId,
          },
        ],
      };
    },
    readRuntimeSessionEventsByType: () => [],
  };

  const centerContext = {
    input: {
      repoId: "repo-remote-steer",
      rootDir,
      now: () => "2026-11-27T00:05:00.000Z",
      schedule: (work: () => void | Promise<void>) => {
        scheduledCallbacks.push(work);
      },
      store: () => ({
        readHead: () => ({ revision: 20 }),
        readEvent: () => null,
        append: (entry: unknown) => {
          storeAppends.push(entry);
          return { revision: 21 };
        },
      }),
      projection: () => projection,
    },
    processes: new Map(),
    requiredRuntimeProjection: () => projection,
    requiredRuntimeStore: () => ({
      readHead: () => ({ revision: 20 }),
      readEvent: () => null,
      append: (entry: unknown) => {
        storeAppends.push(entry);
        return { revision: 21 };
      },
    }),
    publishRuntimeEvent: async (type: string, payload: Record<string, unknown>) => {
      publishedEvents.push({ type, payload });
      return { receipt: { outcome: "applied", revision: 21 } };
    },
    spawnQueuedSteerTurn: async (payload: unknown) => {
      localContinuationSpawns.push(payload);
      return { dispatchId: "dispatch_should_never_spawn" };
    },
    runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as RuntimeSpawnerContext;

  // 1. Running remote codex task with --mode auto forwards to owning edge with mode="auto" (0 center inbox/spawn).
  const autoReceipt = await steerRuntime(
    centerContext,
    { taskId, mode: "auto", prompt: "Focus on remote package A." },
    { actor, source: "local" },
  );
  assert.equal(autoReceipt.ok, true);
  assert.equal(autoReceipt.detail, "steer_requested");
  assert.equal(autoReceipt.targetNodeId, "node-edge-1");
  assert.equal(storeAppends.length, 0, "must never enqueue into center inbox for a remote edge dispatch");
  assert.equal(scheduledCallbacks.length, 0, "must never schedule center-local continuation consumer");
  assert.equal(localContinuationSpawns.length, 0);
  assert.equal(publishedEvents.length, 1);
  assert.equal(publishedEvents[0]!.type, "runtime_session_liveness_changed");
  const autoControl = publishedEvents[0]!.payload.controlRequest as Record<string, unknown>;
  assert.equal(autoControl.action, "steer");
  assert.equal(autoControl.targetNodeId, "node-edge-1");
  assert.equal(autoControl.dispatchId, codexDispatchId);
  assert.equal(autoControl.mode, "auto");

  // 2. Running remote codex task with --mode interrupt forwards mode="interrupt".
  const interruptReceipt = await steerRuntime(
    centerContext,
    { taskId, mode: "interrupt", prompt: "Abort current sub-step." },
    { actor, source: "local" },
  );
  assert.equal(interruptReceipt.detail, "steer_requested");
  assert.equal((publishedEvents[1]!.payload.controlRequest as Record<string, unknown>).mode, "interrupt");

  // 3. Running remote codex task with --mode queue is explicitly rejected (zero local enqueue/spawn, zero live interrupt).
  await assert.rejects(
    () =>
      steerRuntime(centerContext, { taskId, mode: "queue", prompt: "Queue on remote." }, { actor, source: "local" }),
    { code: "runtime_steer_unsupported" },
  );
  assert.equal(publishedEvents.length, 2, "rejected queue steer must not publish a remote control event");
  assert.equal(storeAppends.length, 0);
  assert.equal(scheduledCallbacks.length, 0);

  // 4. Running remote agy task with --mode auto|queue is explicitly rejected (zero center enqueue/spawn).
  latestDispatchId = agyDispatchId;
  for (const mode of ["auto", "queue"] as const) {
    await assert.rejects(
      () => steerRuntime(centerContext, { taskId, mode, prompt: "Steer remote agy." }, { actor, source: "local" }),
      { code: "runtime_steer_unsupported" },
    );
  }
  assert.equal(storeAppends.length, 0);
  assert.equal(scheduledCallbacks.length, 0);

  // 5. Exited remote codex task with --mode auto is explicitly rejected (never spawns duplicate local turn on center).
  latestDispatchId = exitedDispatchId;
  await assert.rejects(
    () =>
      steerRuntime(centerContext, { taskId, mode: "auto", prompt: "After remote exit." }, { actor, source: "local" }),
    { code: "runtime_steer_unavailable" },
  );
  assert.equal(storeAppends.length, 0);
  assert.equal(scheduledCallbacks.length, 0);
  assert.equal(localContinuationSpawns.length, 0);
});

test("F-7C2A9E41: edge control consumer preserves optional mode, stays N-1 compatible without mode, and edge rejects queue without interrupting", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-f7c2a9e41-edge-"));
  t.after(() => removeTempRepository(rootDir));

  const sessionId = "runtime_b10000000000000000000001",
    dispatchId = "dispatch_b10000000000000000000001";
  const legacyNoMode = livenessSteerControlEvent({
    runtimeSessionId: sessionId,
    dispatchId,
    controlRequestId: "ctrl-no-mode",
    opId: "op-no-mode",
    targetNodeId: "node-a",
    prompt: "Legacy frame without mode.",
    workspaceRevision: 11,
  });
  const withAutoMode: Extract<RemoteRuntimeControlEvent, { readonly type: "runtime_session_liveness_changed" }> = {
    ...livenessSteerControlEvent({
      runtimeSessionId: sessionId,
      dispatchId,
      controlRequestId: "ctrl-auto-mode",
      opId: "op-auto-mode",
      targetNodeId: "node-a",
      prompt: "Frame with explicit auto mode.",
      workspaceRevision: 12,
    }),
    payload: {
      runtimeSessionId: sessionId,
      liveness: "live",
      controlRequest: {
        action: "steer",
        controlRequestId: "ctrl-auto-mode",
        targetNodeId: "node-a",
        dispatchId,
        prompt: "Frame with explicit auto mode.",
        mode: "auto",
      },
    },
  };
  const withQueueMode: Extract<RemoteRuntimeControlEvent, { readonly type: "runtime_session_liveness_changed" }> = {
    ...withAutoMode,
    eventId: "event-op-queue-mode",
    opId: "op-queue-mode",
    workspaceRevision: 13,
    payload: {
      runtimeSessionId: sessionId,
      liveness: "live",
      controlRequest: {
        action: "steer",
        controlRequestId: "ctrl-queue-mode",
        targetNodeId: "node-a",
        dispatchId,
        prompt: "Frame with queue mode.",
        mode: "queue",
      },
    },
  };

  assert.deepEqual(validateCurrentAgentRuntimeEvent(legacyNoMode), []);
  assert.deepEqual(validateCurrentAgentRuntimeEvent(withAutoMode), []);
  assert.deepEqual(validateCurrentAgentRuntimeEvent(withQueueMode), []);
  assert.equal(extractRemoteControlRequest(legacyNoMode)?.kind, "steer");
  assert.equal((extractRemoteControlRequest(legacyNoMode) as { mode?: string }).mode, undefined);
  assert.equal((extractRemoteControlRequest(withAutoMode) as { mode?: string }).mode, "auto");
  assert.equal((extractRemoteControlRequest(withQueueMode) as { mode?: string }).mode, "queue");

  openDispatchStream(rootDir, {
    dispatchId,
    runtimeSessionId: sessionId,
    taskId: "task_b10000000000000000000001",
    executionId: "exe_b10000000000000000000001",
    instanceId: "inst-codex",
    kindId: "codex",
    model: "gpt-5.6-sol",
    cwd: rootDir,
    startedAt: "2026-11-27T00:00:00.000Z",
    binding: { actor, source: { kind: "node", nodeId: "node-a" } },
  });
  const active = createActiveRuntime({
    process: {
      pid: 99998,
      onOutput: () => undefined,
      onErrorOutput: () => undefined,
      onExit: () => undefined,
      terminate: () => undefined,
    },
    dispatchId,
    runtimeSessionId: sessionId,
    dispatchOpId: "op-disp-edge-mode",
    instanceId: "inst-codex",
    kindId: "codex",
    resolvedProviderDirectory: null,
    permissionMode: null,
    agent: null,
    role: "worker",
    delegatedBy: null,
    squadId: null,
    publicationOwner: "runtime",
    parentRuntimeSessionId: null,
    binding: { actor, source: { kind: "node", nodeId: "node-a" } },
    task: { taskId: "task_b10000000000000000000001", executionId: "exe_b10000000000000000000001", leaseVersion: 1 },
    decisionReviewTarget: null,
    schedule: null,
    cwd: rootDir,
    prompt: "edge codex worker",
    onExitCommand: null,
    model: "gpt-5.6-sol",
    reasoningEffort: null,
    fast: false,
    tokenLimit: null,
    stallTimeoutMs: 60_000,
    lastProgressAtMs: Date.now(),
    steerReceiptCapable: true,
    startedAt: "2026-11-27T00:00:00.000Z",
    stream: {} as never,
    resumeProviderSessionId: null,
    providerSessionId: "thread-edge-mode-1",
  });
  const edgeContext = {
    input: {
      repoId: "repo-edge-mode",
      rootDir,
      runtimeNode: { nodeId: "node-a" },
      now: () => "2026-11-27T00:05:00.000Z",
      remote: {
        readDispatchLifecycle: async () => ({
          status: "ready",
          watermark: 20,
          sourceRevision: 20,
          rows: [
            {
              attempt: {
                dispatchId,
                runtimeSessionId: sessionId,
                kindId: "codex",
                phase: "running",
                process: "alive",
                stopProof: "none",
                outcome: null,
                fence: { verified: true, owner: "node:node-a" },
              },
              policy: { processAlive: true, canSteer: true, attemptSettled: false, groupSettled: false },
              controlLeafDispatchId: dispatchId,
            },
          ],
        }),
      },
    },
    processes: new Map([[sessionId, active]]),
    runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as RuntimeSpawnerContext;

  const observedModes: Array<string | undefined> = [];
  const rejections: Array<{ readonly controlRequestId: string; readonly code: string }> = [];
  const consumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [sessionId],
    isRuntimeActive: (id) => id === sessionId,
    readControlEventsPage: makePagedReader([legacyNoMode, withAutoMode, withQueueMode]).readControlEventsPage,
    executeCancel: async () => undefined,
    executeSteer: async (req) => {
      observedModes.push(req.mode);
      await steerRuntime(
        edgeContext,
        {
          runtimeSessionId: req.runtimeSessionId,
          prompt: req.prompt,
          ...(req.mode !== undefined ? { mode: req.mode } : {}),
        },
        { actor, source: { kind: "node", nodeId: "node-a" } },
        { remoteControlRequestId: req.controlRequestId, remoteControlOpId: req.opId },
      );
    },
    reportSteerRejection: (req, rejection) => {
      rejections.push({ controlRequestId: req.controlRequestId, code: rejection.code });
    },
    schedule: async (work) => {
      await work();
    },
  });

  await consumer.drain();
  assert.deepEqual(observedModes, [undefined, "auto", "queue"]);
  assert.equal(
    readRuntimeSteerVersion(rootDir, dispatchId),
    2,
    "only N-1 no-mode and auto steers append; queue must not interrupt",
  );
  assert.deepEqual(rejections, [{ controlRequestId: "ctrl-queue-mode", code: "runtime_steer_unsupported" }]);
});

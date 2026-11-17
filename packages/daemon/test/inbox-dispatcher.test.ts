// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  reduceRuntimeInbox,
  type AgentRuntimeEventV1,
  type CanonicalEventStore,
  type DispatchLifecycleQuery,
  type DispatchLifecycleView,
  type RuntimeInboxGroup,
  type RuntimeInboxInput,
  type RuntimeSession,
  type TaskProjection,
} from "@harness-anything/kernel";
import { makeInboxDispatcher } from "../src/inbox-dispatcher.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";

const ACTOR = { principal: { personId: "person-owner" }, executor: null } as const;

function createHarness(
  options: {
    readonly taskStatus?: string;
    readonly dispatchSource?: "local" | { readonly kind: "node"; readonly nodeId: string };
    readonly dispatchAgentId?: string | null;
    readonly sessionOutcome?: RuntimeSession["outcome"];
    readonly sessionCancelledBy?: RuntimeSession["cancelledBy"];
    readonly stopProof?: "proven_stopped" | "unproven";
    readonly hasRunningAttempt?: boolean;
    readonly onSpawn?: (payload: JsonObject) => JsonObject | Promise<JsonObject>;
    readonly onSquadStart?: (action: JsonObject) => JsonObject | Promise<JsonObject>;
  } = {},
) {
  let revision = 0,
    nowMs = Date.parse("2026-11-17T00:00:00.000Z");
  const groups = new Map<string, RuntimeInboxGroup>(),
    appendedEvents: AgentRuntimeEventV1[] = [],
    spawnCalls: JsonObject[] = [],
    squadStartCalls: JsonObject[] = [],
    scheduledTimers = new Map<number, { fn: () => void; delayMs: number }>();
  let nextTimerId = 1;

  const dispatchId = "dispatch_000000000000000000000001",
    runtimeSessionId = "runtime-source-1",
    dispatchEvent: Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> = {
      schema: "agent-runtime-event/v1",
      eventId: "event-dispatch-1",
      workspaceRevision: 1,
      opId: "op-dispatch-1",
      actor: ACTOR,
      source: options.dispatchSource ?? "local",
      occurredAt: "2026-11-17T00:00:00.000Z",
      type: "runtime_dispatch_requested",
      payload: {
        dispatchId,
        runtimeSessionId,
        instanceId: "inst-codex",
        installationId: "install-codex",
        kindId: "codex",
        dispatchKey: "first-run",
        definitionSnapshotRef: "artifact:runtime-definition/sha256/" + "a".repeat(64),
        definitionSnapshot: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId: "inst-codex",
          installationId: "install-codex",
          kindId: "codex",
          providerId: "openai",
          model: "gpt-5",
          reasoningEffort: null,
          baseUrl: null,
          authMode: "subscription",
        },
        taskId: "task-1",
        executionId: "exe-1",
        cwd: "/tmp/repo",
        ...(options.dispatchAgentId ? { agentId: options.dispatchAgentId } : {}),
      },
    };

  const session: RuntimeSession = {
    schema: "runtime-session/v1",
    runtimeSessionId,
    instanceId: "inst-codex",
    installationId: "install-codex",
    kindId: "codex",
    definitionSnapshotRef: dispatchEvent.payload.definitionSnapshotRef,
    launchGeneration: 1,
    attachable: false,
    liveness: "exited",
    providerSessionId: "provider-sess-1",
    transcriptRef: null,
    providerUnreachable: null,
    taskBindings: [],
    cancelledBy: options.sessionCancelledBy ?? null,
    outcome: options.sessionOutcome ?? "stopped",
    exitCode: 0,
    resultRef: null,
    reasonCode: "ruling_resolved",
    startedAt: "2026-11-17T00:00:00.000Z",
    lastObservedAt: "2026-11-17T00:00:00.000Z",
  };

  let stopProof: "proven_stopped" | "unproven" = options.stopProof ?? "proven_stopped";
  let runningAttempt = options.hasRunningAttempt ?? false;

  const lifecycleView = (overrides: Partial<DispatchLifecycleView["attempt"]> = {}): DispatchLifecycleView =>
    ({
      attemptGroupId: dispatchId,
      groupPhase: runningAttempt ? "running" : "closed",
      currentDispatchId: dispatchId,
      controlLeafDispatchId: dispatchId,
      attempt: {
        dispatchId,
        runtimeSessionId,
        stopProof,
        process: runningAttempt ? "alive" : "exited",
        task: {
          taskId: "task-1",
          executionId: "exe-1",
          role: "implementer",
          leaseVersion: 1,
          leaseReleased: !runningAttempt,
        },
        ...overrides,
      },
      policy: {
        attemptSettled: !runningAttempt,
        groupSettled: !runningAttempt,
        canResolveRuling: false,
        fallbackPending: false,
      },
    }) as unknown as DispatchLifecycleView;

  const projection = {
    read: (taskId: string) => ({
      snapshot: {
        task: {
          taskId,
          taskClass: "docs",
          status: options.taskStatus ?? "planned",
          iteration: 1,
          currentNode: "implementation",
        },
        executions: [{ executionId: "exe-1", iteration: 1, state: "active" }],
      },
      packagePath: `harness/tasks/${taskId}`,
    }),
    readPresetSnapshot: () => ({ snapshot: { profile: { outputShape: "docs" } } }),
    readRuntimeDispatchById: (id: string) => (id === dispatchId ? { event: dispatchEvent } : null),
    readRuntimeSession: (id: string) => (id === runtimeSessionId ? session : null),
    readRuntimeSessionEventsByType: () => [],
    readSquadRuns: () => [],
    readLatestLeaseIntervalForExecution: () => ({
      holder: { actor: ACTOR, source: options.dispatchSource ?? "local" },
    }),
    readRuntimeInbox: (query: { by: "inbox" | "open"; inboxId?: string }) => {
      if (query.by === "inbox") {
        const g = groups.get(query.inboxId!);
        return {
          status: "ready" as const,
          watermark: revision,
          sourceRevision: revision,
          rows: g ? [g] : [],
          nextCursor: null,
        };
      }
      const open = [...groups.values()].filter((g) =>
        g.items.some((i) => i.status === "pending" || i.status === "leased"),
      );
      return { status: "ready" as const, watermark: revision, sourceRevision: revision, rows: open, nextCursor: null };
    },
    readDispatchLifecycle: (query: DispatchLifecycleQuery) => {
      if (query.by === "active")
        return {
          status: "ready" as const,
          watermark: revision,
          sourceRevision: revision,
          rows: runningAttempt ? [lifecycleView()] : [],
          nextCursor: null,
        };
      if (query.by === "dispatch")
        return {
          status: "ready" as const,
          watermark: revision,
          sourceRevision: revision,
          rows: query.dispatchIds.includes(dispatchId) ? [lifecycleView()] : [],
          nextCursor: null,
        };
      return { status: "ready" as const, watermark: revision, sourceRevision: revision, rows: [], nextCursor: null };
    },
  } as unknown as TaskProjection;

  const applyEvent = (type: AgentRuntimeEventV1["type"], payload: Record<string, unknown>, opId: string) => {
    revision += 1;
    const event = {
      schema: "agent-runtime-event/v1",
      eventId: `event-${revision}`,
      workspaceRevision: revision,
      opId,
      actor: ACTOR,
      source: "local" as const,
      occurredAt: new Date(nowMs).toISOString(),
      type,
      payload,
    } as AgentRuntimeEventV1;
    if (type === "runtime_inbox_enqueued" || type === "runtime_inbox_claimed" || type === "runtime_inbox_settled") {
      const step = reduceRuntimeInbox(groups.get(String(payload.inboxId)) ?? null, event as RuntimeInboxInput);
      if (step.kind === "ignored") throw Object.assign(new Error(step.reason), { code: "op_conflict" });
      groups.set(step.group.inboxId, step.group);
    }
    appendedEvents.push(event);
    return { outcome: "applied", opId, revision };
  };

  const dispatcher = makeInboxDispatcher({
    rootDir: "/tmp/repo",
    repoId: "repo-test",
    mode: "local",
    now: () => new Date(nowMs).toISOString(),
    projection,
    store: {} as CanonicalEventStore,
    schedule: (work) => {
      void work();
    },
    appendAuxiliaryRuntimeIngress: (action, _binding) =>
      applyEvent(action.type, action.payload as Record<string, unknown>, action.opId) as never,
    runtimeSpawner: {
      prepareWorktree: async () => null,
      spawn: async (payload) => {
        spawnCalls.push(payload);
        if (options.onSpawn) return options.onSpawn(payload);
        return { outcome: "applied", dispatchId: `dispatch_${String(spawnCalls.length).padStart(24, "0")}` };
      },
    },
    squadCoordinator: {
      start: async (action) => {
        squadStartCalls.push(action);
        if (options.onSquadStart) return options.onSquadStart(action);
        return { squadRunId: "squad_000000000000000000000001", stateDispatchId: "dispatch_000000000000000000000099" };
      },
    },
    authorizeRuntimeAction: async (_action, binding) => binding,
    onlineBinding: async (binding) => binding,
    setTimer: (fn, delayMs) => {
      const id = nextTimerId++;
      scheduledTimers.set(id, { fn, delayMs });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => {
      scheduledTimers.delete(handle as unknown as number);
    },
  });

  return {
    dispatcher,
    appendedEvents,
    spawnCalls,
    squadStartCalls,
    scheduledTimers,
    enqueue: (overrides: Record<string, unknown> = {}) =>
      applyEvent(
        "runtime_inbox_enqueued",
        {
          inboxId: "task:task-1",
          itemId: `item-${revision + 1}`,
          source: "ruling_resolved",
          dedupeKey: `ruling:${revision + 1}`,
          coalesceWindowMs: 0,
          midRunPolicy: "defer_next_run",
          taskId: "task-1",
          dispatchId,
          squadRunId: null,
          agentId: null,
          summary: "Owner answered",
          data: {
            kind: "ruling_resolved",
            taskId: "task-1",
            dispatchId,
            answer: "ok",
            runtimeInstanceId: "inst-codex",
          },
          contextRef: null,
          enqueuedAt: new Date(nowMs).toISOString(),
          ...overrides,
        },
        `op-enqueue-${revision + 1}`,
      ),
    setNow: (iso: string) => {
      nowMs = Date.parse(iso);
    },
    setStopProof: (value: "proven_stopped" | "unproven") => {
      stopProof = value;
    },
    setRunning: (value: boolean) => {
      runningAttempt = value;
    },
    fireNextTimer: () => {
      const first = scheduledTimers.entries().next();
      if (first.done) return false;
      const [id, entry] = first.value;
      scheduledTimers.delete(id);
      nowMs += entry.delayMs;
      entry.fn();
      return true;
    },
  };
}

test("InboxDispatcher defers mid-run, gates on proven_stopped, coalesces via fake timer, and resumes", async () => {
  const h = createHarness({ hasRunningAttempt: true, stopProof: "unproven" });
  h.enqueue({ coalesceWindowMs: 5000 });
  await h.dispatcher.drain();
  assert.equal(h.spawnCalls.length, 0, "must defer while attempt is running");

  h.setRunning(false);
  await h.dispatcher.drain();
  assert.equal(h.spawnCalls.length, 0, "must wait until stopProof === proven_stopped");

  h.setStopProof("proven_stopped");
  await h.dispatcher.drain();
  assert.equal(h.spawnCalls.length, 0, "must coalesce until coalesceWindowMs elapses");
  assert.equal(h.scheduledTimers.size, 1);

  assert.equal(h.fireNextTimer(), true);
  await h.dispatcher.drain();
  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.spawnCalls[0]?.providerSessionId, "provider-sess-1");
  const settled = h.appendedEvents.find((e) => e.type === "runtime_inbox_settled");
  assert.equal(settled?.type, "runtime_inbox_settled");
  if (settled?.type === "runtime_inbox_settled") assert.equal(settled.payload.settlement, "consumed");
  h.dispatcher.close();
});

test("InboxDispatcher skips remote edge dispatches without claiming on center", async () => {
  const h = createHarness({ dispatchSource: { kind: "node", nodeId: "edge-1" } });
  h.enqueue();
  await h.dispatcher.drain();
  assert.equal(h.spawnCalls.length, 0);
  assert.equal(
    h.appendedEvents.some((e) => e.type === "runtime_inbox_claimed"),
    false,
  );
  h.dispatcher.close();
});

test("InboxDispatcher emits runtime_session_resume_degraded and falls back to fresh spawn when --resume fails", async () => {
  let attempt = 0;
  const h = createHarness({
    dispatchAgentId: "terra",
    onSpawn: () => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error("resume session expired"), { code: "runtime_resume_failed" });
      return { outcome: "applied", dispatchId: "dispatch_000000000000000000000022" };
    },
  });
  h.enqueue({ agentId: "terra" });
  await h.dispatcher.drain();
  assert.equal(h.spawnCalls.length, 2);
  assert.equal(h.spawnCalls[0]?.providerSessionId, "provider-sess-1");
  assert.equal(h.spawnCalls[1]?.providerSessionId, undefined);
  const degraded = h.appendedEvents.find((e) => e.type === "runtime_session_resume_degraded");
  assert.equal(degraded?.type, "runtime_session_resume_degraded");
  if (degraded?.type === "runtime_session_resume_degraded") {
    assert.equal(degraded.payload.degradedTo, "fresh");
    assert.equal(degraded.payload.reasonCode, "runtime_resume_failed");
  }
  h.dispatcher.close();
});

test("InboxDispatcher blocks cross-employee resume without HandoffPacketV1 and starts Squad rulings", async () => {
  const hBlocked = createHarness({ dispatchAgentId: "terra" });
  hBlocked.enqueue({ agentId: "hydrogen" });
  await hBlocked.dispatcher.drain();
  assert.equal(hBlocked.spawnCalls.length, 0);
  const dead = hBlocked.appendedEvents.find((e) => e.type === "runtime_inbox_settled");
  assert.equal(dead?.type, "runtime_inbox_settled");
  if (dead?.type === "runtime_inbox_settled") assert.equal(dead.payload.settlement, "dead_letter");
  hBlocked.dispatcher.close();

  const hSquad = createHarness();
  hSquad.enqueue({
    squadRunId: "squad_000000000000000000000001",
    data: {
      kind: "ruling_resolved",
      taskId: "task-1",
      dispatchId: "dispatch_000000000000000000000001",
      answer: "yes",
      runtimeInstanceId: "inst-codex",
      squadId: "core-squad",
      squadRunId: "squad_000000000000000000000001",
    },
  });
  await hSquad.dispatcher.drain();
  assert.equal(hSquad.squadStartCalls.length, 1);
  assert.equal(hSquad.squadStartCalls[0]?.squadId, "core-squad");
  hSquad.dispatcher.close();
});

test("InboxDispatcher distinguishes escalated stopped sessions from explicitly cancelled sessions", async () => {
  const hEscalated = createHarness({ sessionOutcome: "stopped", sessionCancelledBy: ACTOR });
  hEscalated.enqueue();
  await hEscalated.dispatcher.drain();
  assert.equal(hEscalated.spawnCalls.length, 1);
  assert.equal(hEscalated.spawnCalls[0]?.providerSessionId, "provider-sess-1");
  assert.equal(
    hEscalated.appendedEvents.some((e) => e.type === "runtime_session_resume_degraded"),
    false,
  );
  hEscalated.dispatcher.close();

  const hCancelled = createHarness({ sessionOutcome: "cancelled", sessionCancelledBy: ACTOR });
  hCancelled.enqueue();
  await hCancelled.dispatcher.drain();
  assert.equal(hCancelled.spawnCalls.length, 1);
  assert.equal(hCancelled.spawnCalls[0]?.providerSessionId, undefined);
  const degraded = hCancelled.appendedEvents.find((e) => e.type === "runtime_session_resume_degraded");
  assert.equal(degraded?.type, "runtime_session_resume_degraded");
  if (degraded?.type === "runtime_session_resume_degraded") {
    assert.equal(degraded.payload.degradedTo, "fresh");
    assert.equal(degraded.payload.reasonCode, "unclean_prior_terminal");
  }
  hCancelled.dispatcher.close();
});

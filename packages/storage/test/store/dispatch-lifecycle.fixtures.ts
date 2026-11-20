import { taskLifecycleWritePlan, type CanonicalEventV1, type TaskProjection } from "@harness-anything/kernel";
import {
  runtimeEventContentClaims,
  validateCurrentAgentRuntimeEvent,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { submissionDigest } from "@harness-anything/kernel/internal/domain/execution.ts";
import { reviewDigest } from "@harness-anything/kernel/internal/domain/review.ts";
import { REPLAY_TASK_GRAPH } from "@harness-anything/kernel/internal/domain/task-graph.ts";
import {
  createTaskEvent,
  supersededTaskState,
  type TaskEventV1,
  type TaskMutationEvent,
} from "@harness-anything/kernel/internal/domain/task-lifecycle-event.ts";
import { canonicalEventWritePlan } from "../../src/store/task-event-store.ts";
import {
  applyTransition,
  emptyTaskLifecycleSnapshot,
  normalizeTaskLifecycleCommand,
  type TaskLifecycleSnapshot,
} from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";

const actor = { principal: { personId: "person-runtime" }, executor: null } as const;
let revision = 0;

export function runtimeEvent(type: AgentRuntimeEventV1["type"], payload: Record<string, unknown>): AgentRuntimeEventV1 {
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

export const requested = (
  dispatchId: string,
  runtimeSessionId: string,
  attemptGroupId?: string,
  extra: Record<string, unknown> = {},
) =>
  runtimeEvent("runtime_dispatch_requested", {
    dispatchId,
    runtimeSessionId,
    instanceId: "codex-fixture",
    installationId: "installation-codex",
    kindId: extra.kindId ?? "codex",
    dispatchKey: `${dispatchId}-key`,
    definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
    definitionSnapshot: {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: "codex-fixture",
      installationId: "installation-codex",
      kindId: extra.kindId ?? "codex",
      providerId: "openai",
      model: "codex-fixture",
      reasoningEffort: null,
      endpointKind: "official",
      baseUrlHash: null,
      authMode: "subscription",
    },
    ...extra,
    ...(attemptGroupId ? { attemptGroupId, attemptIndex: 1 } : {}),
  });
export const started = (runtimeSessionId: string, kindId = "codex") =>
  runtimeEvent("runtime_session_started", {
    runtimeSessionId,
    instanceId: "codex-fixture",
    installationId: "installation-codex",
    kindId,
    definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
    launchGeneration: 1,
    attachable: false,
  });
export const outcome = (runtimeSessionId: string, value: string, attempt?: Record<string, unknown>) =>
  runtimeEvent("runtime_session_outcome_observed", {
    runtimeSessionId,
    outcome: value,
    exitCode: null,
    resultRef: `artifact:runtime-result/sha256/${"0".repeat(64)}`,
    result: null,
    ...(attempt ? { attempt } : {}),
  });

export function history(): AgentRuntimeEventV1[] {
  revision = 0;
  return [
    // A fallback group: the first attempt schedules a successor, which is still running.
    requested("dispatch-a", "session-a"),
    started("session-a"),
    runtimeEvent("runtime_session_exited", { runtimeSessionId: "session-a" }),
    outcome("session-a", "failed", { classification: "provider_quota", reason: "quota", fallbackState: "scheduled" }),
    requested("dispatch-a2", "session-a2", "dispatch-a", { kindId: "agy" }),
    started("session-a2", "agy"),
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

export function snapshot(projection: Pick<TaskProjection, "readDispatchLifecycle">) {
  const active = projection.readDispatchLifecycle({ by: "active", instanceId: "codex-fixture", limit: 10 }),
    points = projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: ["dispatch-a", "dispatch-c"] }),
    session = projection.readDispatchLifecycle({ by: "session", runtimeSessionId: "session-b" });
  return { active, points, session };
}

export function appendTaskTerminalLifecycleHistory(
  store: { readonly append: (entry: never) => unknown },
  onEvent?: (event: CanonicalEventV1) => void,
): void {
  for (const event of taskTerminalLifecycleHistory()) {
    const plan =
        event.schema === "agent-runtime-event/v1"
          ? canonicalEventWritePlan(event, "agent-runtime/v1", event.opId)
          : taskLifecycleWritePlan(event as TaskEventV1),
      blobs =
        event.schema === "agent-runtime-event/v1"
          ? runtimeEventContentClaims(event as AgentRuntimeEventV1).map((claim) => ({ ...claim, body: "" }))
          : [];
    store.append({ event, plan, blobs } as never);
    onEvent?.(event);
  }
}

/**
 * Valid multi-task history exercising all Issue #4632 closure triggers (task_completed, terminal
 * task_transitioned, task_superseded, task_completion_generation_retired, execution_started) plus
 * negative controls (non-terminal task_transitioned and live running attempts).
 */
export function taskTerminalLifecycleHistory(): readonly CanonicalEventV1[] {
  const implementer = { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "codex" } },
    reviewer = { principal: { personId: "person-reviewer" }, executor: { kind: "agent" as const, id: "reviewer" } },
    presetSnapshotDigest = `sha256:${"a".repeat(64)}` as const,
    commitSha = "a".repeat(40),
    completionContract = {
      presetSnapshotDigest,
      closeoutGates: { review: true, consent: true, factDisposition: true },
      gates: [],
    };
  let globalRevision = 0;
  const stamp = (eventIdPrefix: string) => {
    globalRevision += 1;
    return {
      revision: globalRevision,
      eventId: `${eventIdPrefix}-ev-${globalRevision}`,
      opId: `${eventIdPrefix}-op-${globalRevision}`,
      occurredAt: `2026-11-08T00:${String(Math.floor(globalRevision / 60)).padStart(2, "0")}:${String(globalRevision % 60).padStart(2, "0")}.000Z`,
    };
  };
  const emitRuntime = (
    type: AgentRuntimeEventV1["type"],
    payload: Record<string, unknown>,
    source: AgentRuntimeEventV1["source"] = { kind: "node", nodeId: "node-a" },
  ): AgentRuntimeEventV1 => {
    const s = stamp("rt"),
      event = {
        schema: "agent-runtime-event/v1",
        eventId: s.eventId,
        workspaceRevision: s.revision,
        opId: s.opId,
        actor,
        source,
        occurredAt: s.occurredAt,
        type,
        payload,
      } as AgentRuntimeEventV1;
    const errors = validateCurrentAgentRuntimeEvent(event);
    if (errors.length > 0) throw new Error(errors.join("; "));
    return event;
  };
  const events: CanonicalEventV1[] = [];
  const createTaskRunner = (taskId: string) => {
    let taskSnapshot: TaskLifecycleSnapshot = emptyTaskLifecycleSnapshot();
    const run = (
      actorAxes: typeof implementer | typeof reviewer,
      intent: Parameters<typeof normalizeTaskLifecycleCommand>[1],
      proof: unknown,
    ) => {
      const normalized = normalizeTaskLifecycleCommand(
          { workspaceId: "workspace-1", actor: actorAxes, source: "local", expectedRevision: taskSnapshot.revision },
          intent,
        ),
        result = applyTransition(
          taskSnapshot,
          {
            ...normalized,
            eventId: `local-${taskSnapshot.revision + 1}`,
            workspaceRevision: taskSnapshot.revision + 1,
            occurredAt: "2026-11-08T00:00:00.000Z",
          },
          proof as never,
        );
      taskSnapshot = result.snapshot;
      const s = stamp("tk");
      const emitted: TaskEventV1 = {
        ...result.event,
        eventId: s.eventId,
        opId: s.opId,
        workspaceRevision: s.revision,
        occurredAt: s.occurredAt,
      };
      events.push(emitted);
      return emitted;
    };
    const startExec = (executionId: string) =>
      run(
        implementer,
        { type: "StartExecution", taskId, executionId },
        {
          actorBinding: implementer,
          deliveryBaseline: { kind: "commit", commitSha: "0".repeat(40) },
          reservation: {
            taskId,
            executionId,
            expiresAt: "2099-01-01T00:00:00.000Z",
            ttlMs: 1_800_000,
            previousHolder: null,
            reason: "initial_claim",
            version: 0,
          },
        },
      );
    run(
      implementer,
      {
        type: "CreateReplayTask",
        taskId,
        title: `Task ${taskId}`,
        taskClass: "standard",
        graph: REPLAY_TASK_GRAPH,
        completionGateIds: [],
        presetSnapshotDigest,
      },
      { taskIdUnique: true, actorBinding: implementer },
    );
    return { run, startExec, snapshot: () => taskSnapshot };
  };
  const emitStoppedFallback = (dispatchId: string, sessionId: string, taskId: string, executionId: string) => {
    events.push(
      emitRuntime("runtime_dispatch_requested", {
        ...requested(dispatchId, sessionId, undefined, { taskId, executionId }).payload,
      }),
      emitRuntime("runtime_session_started", {
        ...started(sessionId).payload,
      }),
      emitRuntime("runtime_session_exited", { runtimeSessionId: sessionId }),
      emitRuntime("runtime_session_outcome_observed", {
        ...outcome(sessionId, "failed", {
          classification: "provider_quota",
          reason: "quota",
          fallbackState: "scheduled",
        }).payload,
      }),
    );
  };
  const emitAwaitingRuling = (dispatchId: string, sessionId: string, taskId: string, executionId: string) => {
    events.push(
      emitRuntime("runtime_dispatch_requested", {
        ...requested(dispatchId, sessionId, undefined, { taskId, executionId }).payload,
      }),
      emitRuntime("runtime_session_started", {
        ...started(sessionId).payload,
      }),
      emitRuntime("runtime_session_exited", { runtimeSessionId: sessionId }),
      emitRuntime("runtime_session_outcome_observed", {
        ...outcome(sessionId, "failed", { classification: "awaiting_ruling", reason: "ruling required" }).payload,
      }),
    );
  };

  // 1. task-done: waiting_backoff -> closed on task_completed.
  const tDone = createTaskRunner("task-done"),
    doneSubmission = {
      completionClaim: "done",
      deliverables: [],
      outputs: [],
      verificationNotes: ["tests"],
      knownGaps: [],
      residualRisks: [],
      commitSha,
      completionContract,
    };
  tDone.startExec("exec-done");
  emitStoppedFallback("d-done", "s-done", "task-done", "exec-done");
  tDone.run(
    implementer,
    { type: "SubmitExecution", taskId: "task-done", executionId: "exec-done", submission: doneSubmission },
    { actorBinding: implementer, leaseVersion: 0, sessionDisposition: "complete" },
  );
  tDone.run(
    reviewer,
    {
      type: "RecordReview",
      taskId: "task-done",
      executionId: "exec-done",
      reviewId: "rev-done",
      verdict: "approved",
      reason: "lgtm",
      evidenceChecked: [],
      commitSha,
      iteration: 0,
      contentDigest: `sha256:${"b".repeat(64)}`,
      submissionDigest: submissionDigest(doneSubmission),
      findings: [],
      resolutions: [],
    },
    { actorBinding: reviewer, capability: "execution-review@v1", capabilityRef: "cap-rev", reworkBudget: 2 },
  );
  const doneReview = tDone.snapshot().reviews[0]!;
  tDone.run(
    implementer,
    {
      type: "RecordReviewConsent",
      taskId: "task-done",
      executionId: "exec-done",
      reviewId: doneReview.reviewId,
      consentId: "consent-done",
      reviewDigest: reviewDigest(doneReview),
      contentDigest: doneReview.contentDigest,
    },
    { actorBinding: implementer, capability: "execution-consent@v1", capabilityRef: "cap-con" },
  );
  tDone.run(
    implementer,
    { type: "CompleteTask", taskId: "task-done", executionId: "exec-done" },
    {
      capability: "task-complete@v1",
      capabilityRef: "cap-done",
      actorRole: "owner",
      noActiveLease: true,
      closeoutGates: completionContract.closeoutGates,
      gateReceipts: [],
    },
  );

  // 2. task-cancel: awaiting_ruling (after lease_released) -> closed on terminal task_transitioned("cancelled").
  const tCancel = createTaskRunner("task-cancel");
  tCancel.startExec("exec-cancel");
  emitAwaitingRuling("d-cancel", "s-cancel", "task-cancel", "exec-cancel");
  tCancel.run(
    implementer,
    { type: "ReleaseRuntimeLease", taskId: "task-cancel", executionId: "exec-cancel", leaseVersion: 0, reason: "stop" },
    {},
  );
  tCancel.run(
    implementer,
    { type: "TransitionTask", taskId: "task-cancel", status: "cancelled", reason: "cancelled", force: true },
    {},
  );

  // 3. task-supersede: waiting_backoff -> closed on task_superseded.
  const tSup = createTaskRunner("task-supersede");
  tSup.startExec("exec-sup");
  emitStoppedFallback("d-supersede", "s-supersede", "task-supersede", "exec-sup");
  tSup.run(
    implementer,
    { type: "ReleaseRuntimeLease", taskId: "task-supersede", executionId: "exec-sup", leaseVersion: 0, reason: "stop" },
    {},
  );
  const supStamp = stamp("tk");
  events.push(
    createTaskEvent<TaskMutationEvent>(
      {
        eventId: supStamp.eventId,
        workspaceRevision: supStamp.revision,
        opId: supStamp.opId,
        taskId: "task-supersede",
        actor: implementer,
        source: "local",
        occurredAt: supStamp.occurredAt,
      },
      "task_superseded",
      {
        task: supersededTaskState(tSup.snapshot().task!, "task-replacement"),
        mutation: { command: "supersede", reason: "replaced", fields: ["status", "supersededBy"] },
      },
    ),
  );

  // 4. task-retire: awaiting_ruling -> closed on task_completion_generation_retired.
  const tRet = createTaskRunner("task-retire");
  tRet.startExec("exec-ret-1");
  emitAwaitingRuling("d-retire", "s-retire", "task-retire", "exec-ret-1");
  tRet.run(
    implementer,
    { type: "ReleaseRuntimeLease", taskId: "task-retire", executionId: "exec-ret-1", leaseVersion: 0, reason: "stop" },
    {},
  );
  tRet.run(
    implementer,
    { type: "RetireCompletionGeneration", taskId: "task-retire", executionId: "exec-ret-1", sourceGeneration: 1 },
    {},
  );

  // 5. task-replace: waiting_backoff -> closed on new execution_started ("exec-rep-2").
  const tRep = createTaskRunner("task-replace"),
    repSubmission = {
      completionClaim: "round 1",
      deliverables: [],
      outputs: [],
      verificationNotes: ["tests"],
      knownGaps: [],
      residualRisks: [],
      commitSha,
      completionContract,
    };
  tRep.startExec("exec-rep-1");
  emitStoppedFallback("d-replace", "s-replace", "task-replace", "exec-rep-1");
  tRep.run(
    implementer,
    { type: "SubmitExecution", taskId: "task-replace", executionId: "exec-rep-1", submission: repSubmission },
    { actorBinding: implementer, leaseVersion: 0, sessionDisposition: "complete" },
  );
  tRep.run(
    reviewer,
    {
      type: "RecordReview",
      taskId: "task-replace",
      executionId: "exec-rep-1",
      reviewId: "rev-rep-1",
      verdict: "changes_requested",
      reason: "rework",
      evidenceChecked: [],
      commitSha,
      iteration: 0,
      contentDigest: `sha256:${"c".repeat(64)}`,
      submissionDigest: submissionDigest(repSubmission),
      findings: [{ findingId: "f-rep-1", blocking: true, text: "needs another pass" }],
      resolutions: [],
    },
    { actorBinding: reviewer, capability: "execution-review@v1", capabilityRef: "cap-rep", reworkBudget: 2 },
  );
  tRep.startExec("exec-rep-2");

  // 6a. Negative control: non-terminal task_transitioned("blocked") keeps waiting_backoff open.
  const tNonTerm = createTaskRunner("task-nonterm");
  tNonTerm.startExec("exec-nonterm");
  emitStoppedFallback("d-nonterm", "s-nonterm", "task-nonterm", "exec-nonterm");
  tNonTerm.run(
    implementer,
    {
      type: "ReleaseRuntimeLease",
      taskId: "task-nonterm",
      executionId: "exec-nonterm",
      leaseVersion: 0,
      reason: "pause",
    },
    {},
  );
  tNonTerm.run(
    implementer,
    { type: "TransitionTask", taskId: "task-nonterm", status: "blocked", reason: "blocked", force: false },
    {},
  );

  // 6b. Negative control: live running group never closes or releases slot on terminal transition.
  const tLive = createTaskRunner("task-live");
  tLive.startExec("exec-live");
  events.push(
    emitRuntime("runtime_dispatch_requested", {
      ...requested("d-live", "s-live", undefined, { taskId: "task-live", executionId: "exec-live" }).payload,
    }),
    emitRuntime("runtime_session_started", { ...started("s-live").payload }),
  );
  tLive.run(
    implementer,
    {
      type: "ReleaseRuntimeLease",
      taskId: "task-live",
      executionId: "exec-live",
      leaseVersion: 0,
      reason: "force-cancel",
    },
    {},
  );
  tLive.run(
    implementer,
    {
      type: "TransitionTask",
      taskId: "task-live",
      status: "cancelled",
      reason: "cancelled while running",
      force: true,
    },
    {},
  );

  return events;
}

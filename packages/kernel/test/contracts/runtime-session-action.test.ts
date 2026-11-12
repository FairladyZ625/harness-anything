// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  getExecutableEntityAction,
  sha256Text,
  type AgentRuntimeEventV1,
  type RuntimeSession,
} from "../../src/index.ts";
import { reduceRuntimeSession, validateAgentRuntimePayload } from "../../src/domain/agent-runtime.ts";

const actor = { principal: { personId: "runtime-action" }, executor: null } as const;
const source = { kind: "node", nodeId: "edge-a" } as const;
const compileInput = {
  actor,
  source,
  session: { runtime: "codex", sessionId: "provider-a", transcriptReachability: "by_session_id" } as const,
  opId: "runtime-action-op",
  occurredAt: "2026-09-01T00:00:00.000Z",
  workspaceRevision: 3,
};

test("RuntimeSession start compiles the canonical event and accepts an equal repeated start without a write", () => {
  const action = getExecutableEntityAction("runtime_session_started"),
    command = {
      kind: "runtime_session_started",
      runtimeSessionId: "runtime-action-a",
      instanceId: "instance-a",
      installationId: "installation-a",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/action-a",
      launchGeneration: 2,
      attachable: true,
    };
  assert.ok(action?.execution?.compile);
  const draft = action.execution.compile({ ...compileInput, action: command });
  assert.equal(draft.kind, "runtime-session");
  if (draft.kind !== "runtime-session") return;
  assert.equal(draft.event.type, "runtime_session_started");
  assert.deepEqual(draft.event.payload, {
    runtimeSessionId: "runtime-action-a",
    instanceId: "instance-a",
    installationId: "installation-a",
    kindId: "codex",
    definitionSnapshotRef: "artifact:runtime-definition/action-a",
    launchGeneration: 2,
    attachable: true,
  });
  const current: RuntimeSession = {
    runtimeSessionId: "runtime-action-a",
    instanceId: "instance-a",
    installationId: "installation-a",
    kindId: "codex",
    definitionSnapshotRef: "artifact:runtime-definition/action-a",
    providerSessionId: null,
    transcriptRef: null,
    launchGeneration: 2,
    liveness: "live",
    attachable: true,
    taskBindings: [],
    outcome: null,
    exitCode: null,
    resultRef: null,
    lastObservedAt: "2026-09-01T00:00:00.000Z",
  };
  const repeated = action.execution!.compile!({ ...compileInput, action: command, currentEntity: current });
  assert.equal(repeated.noChanges, true);
});

test("RuntimeSession outcome compilation closes its content claim", () => {
  const body = "runtime action result",
    action = getExecutableEntityAction("runtime_session_outcome_observed"),
    current: RuntimeSession = {
      runtimeSessionId: "runtime-action-outcome",
      instanceId: "instance-a",
      installationId: "installation-a",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/action-a",
      providerSessionId: null,
      transcriptRef: null,
      launchGeneration: 1,
      liveness: "exited",
      attachable: false,
      taskBindings: [],
      outcome: null,
      exitCode: null,
      resultRef: null,
      lastObservedAt: "2026-09-01T00:00:00.000Z",
    },
    command = {
      kind: "runtime_session_outcome_observed",
      runtimeSessionId: current.runtimeSessionId,
      outcome: "succeeded",
      exitCode: 0,
      result: {
        sha256: sha256Text(body),
        size: new TextEncoder().encode(body).byteLength,
        mediaType: "text/plain; charset=utf-8",
      },
      dispatchId: "dispatch-outcome-a",
      endedAt: compileInput.occurredAt,
      runtimeMetrics: {
        inputTokens: 1,
        cacheReadTokens: 2,
        outputTokens: 3,
        totalTokens: 6,
        toolCallCount: 4,
        usageUnavailable: false,
      },
      attempt: {
        classification: "provider_quota",
        reason: "Quota exhausted",
        faultClass: "quota_exhausted",
        resetAt: "2026-09-02T00:00:00Z",
      },
      resultBody: body,
    };
  Object.assign(command, { resultRef: `artifact:runtime-result/sha256/${command.result.sha256}` });
  const draft = action?.execution?.compile?.({ ...compileInput, action: command, currentEntity: current });
  assert.equal(draft?.kind, "runtime-session");
  if (draft?.kind !== "runtime-session") return;
  assert.equal(draft.resultBody, body);
  assert.equal(draft.event.type, "runtime_session_outcome_observed");
  if (draft.event.type !== "runtime_session_outcome_observed") return;
  assert.equal(draft.event.payload.dispatchId, command.dispatchId);
  assert.equal(draft.event.payload.endedAt, command.endedAt);
  assert.deepEqual(draft.event.payload.runtimeMetrics, command.runtimeMetrics);
  assert.deepEqual(draft.event.payload.attempt, command.attempt);
  // A stall is its own classification: the ledger must accept it without a provider fault.
  for (const attempt of [
    { classification: "worker_stop", reason: "Stopped" },
    { classification: "dispatch_stalled", reason: "Dispatch stalled after 300000 ms without progress." },
  ])
    assert.doesNotThrow(() =>
      action.execution!.compile!({ ...compileInput, action: { ...command, attempt }, currentEntity: current }),
    );
  for (const attempt of [
    { ...command.attempt, faultClass: "other" },
    { ...command.attempt, resetAt: "tomorrow" },
  ]) {
    assert.throws(() =>
      action.execution!.compile!({ ...compileInput, action: { ...command, attempt }, currentEntity: current }),
    );
  }
  assert.throws(
    () =>
      action.execution!.compile!({
        ...compileInput,
        action: { ...command, resultBody: "x".repeat(new TextEncoder().encode(body).byteLength) },
        currentEntity: current,
      }),
    (error: unknown) => (error as { readonly code?: unknown }).code === "content_claim_mismatch",
  );
});

test("a dispatch ruling answer is observed without replacing the session's terminal result", () => {
  const current: RuntimeSession = {
      runtimeSessionId: "runtime-ruling-answer",
      instanceId: "instance-a",
      installationId: "installation-a",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/action-a",
      providerSessionId: "provider-a",
      transcriptRef: null,
      launchGeneration: 1,
      liveness: "exited",
      attachable: false,
      taskBindings: [],
      outcome: "stopped",
      exitCode: 2,
      resultRef: "artifact:runtime-result/original",
      lastObservedAt: "2026-09-01T00:00:00.000Z",
    },
    body = "Owner answered the dispatch ruling.",
    compile = getExecutableEntityAction("runtime_session_outcome_observed")!.execution!.compile!,
    draft = compile({
      ...compileInput,
      currentEntity: current,
      action: {
        kind: "runtime_session_outcome_observed",
        runtimeSessionId: current.runtimeSessionId,
        outcome: "stopped",
        reasonCode: "ruling_resolved",
        resultBody: body,
        resultRef: `artifact:runtime-result/sha256/${sha256Text(body)}`,
        result: { sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "text/plain; charset=utf-8" },
      },
    });
  assert.equal(draft.kind, "runtime-session");
  if (draft.kind !== "runtime-session") return;
  assert.notEqual(draft.noChanges, true, "the lifecycle reducer must receive the ruling answer observation");
  assert.deepEqual(reduceRuntimeSession(current, draft.event), current, "the historical exit and result stay intact");
});

test("RuntimeSession stop proof compiles after dispatch admission before session start", () => {
  const action = getExecutableEntityAction("runtime_session_exited");
  assert.ok(action?.execution?.compile);
  const draft = action.execution.compile({
    ...compileInput,
    action: {
      kind: "runtime_session_exited",
      runtimeSessionId: "runtime-pre-session",
      dispatchId: "dispatch-pre-session",
    },
  });
  assert.equal(draft.kind, "runtime-session");
  if (draft.kind !== "runtime-session") return;
  assert.equal(draft.event.type, "runtime_session_exited");
  assert.equal(draft.noChanges, undefined);
  assert.throws(
    () =>
      action.execution!.compile!({
        ...compileInput,
        action: { kind: "runtime_session_exited", runtimeSessionId: "runtime-pre-session" },
      }),
    (error: unknown) => (error as { readonly code?: unknown }).code === "runtime_session_transition_invalid",
  );
  assert.equal(reduceRuntimeSession(null, draft.event, { allowPreSessionTerminal: true }), null);
  const body = "Provider launch was rejected before a session existed.",
    outcome = getExecutableEntityAction("runtime_session_outcome_observed")!.execution!.compile!({
      ...compileInput,
      action: {
        kind: "runtime_session_outcome_observed",
        runtimeSessionId: "runtime-pre-session",
        dispatchId: "dispatch-pre-session",
        outcome: "failed",
        resultRef: `artifact:runtime-result/sha256/${sha256Text(body)}`,
        result: { sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "text/plain; charset=utf-8" },
        resultBody: body,
      },
    });
  assert.equal(outcome.kind, "runtime-session");
  if (outcome.kind !== "runtime-session") return;
  assert.equal(outcome.noChanges, undefined);
  assert.equal(reduceRuntimeSession(null, outcome.event, { allowPreSessionTerminal: true }), null);
  assert.throws(() => reduceRuntimeSession(null, outcome.event), /has not started/u);
});

test("RuntimeSession events use one-time fields, ordered liveness, and terminal outcome completion", () => {
  const event = (type: AgentRuntimeEventV1["type"], payload: Record<string, unknown>) =>
    ({
      schema: "agent-runtime-event/v1",
      eventId: `event-${type}`,
      workspaceRevision: 1,
      opId: `request-${type}`,
      actor,
      source,
      occurredAt: compileInput.occurredAt,
      type,
      payload,
    }) as AgentRuntimeEventV1;
  let session = reduceRuntimeSession(
    null,
    event("runtime_session_started", {
      runtimeSessionId: "runtime-matrix",
      instanceId: "instance-a",
      installationId: "installation-a",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/action-a",
      launchGeneration: 1,
      attachable: true,
    }),
  );
  assert.ok(session);
  const started = event("runtime_session_started", {
    runtimeSessionId: "runtime-matrix",
    instanceId: "instance-a",
    installationId: "installation-a",
    kindId: "codex",
    definitionSnapshotRef: "artifact:runtime-definition/action-a",
    launchGeneration: 1,
    attachable: true,
  });
  assert.equal(reduceRuntimeSession(session, started), session);
  assert.throws(
    () => reduceRuntimeSession(session, event("runtime_session_started", { ...started.payload, kindId: "claude" })),
    { name: "RuntimeSessionFieldConflictError" },
  );
  assert.throws(
    () => reduceRuntimeSession(session, event("runtime_session_started", { ...started.payload, attachable: false })),
    { name: "RuntimeSessionFieldConflictError" },
  );
  const provider = event("runtime_session_provider_bound", {
    runtimeSessionId: "runtime-matrix",
    providerSessionId: "provider-a",
    transcriptRef: "file:runtime-transcripts/a.jsonl",
  });
  session = reduceRuntimeSession(session, provider);
  assert.ok(session);
  assert.equal(reduceRuntimeSession(session, provider), session);
  assert.throws(
    () =>
      reduceRuntimeSession(
        session,
        event("runtime_session_provider_bound", { ...provider.payload, providerSessionId: "provider-b" }),
      ),
    { name: "RuntimeSessionFieldConflictError" },
  );
  session = reduceRuntimeSession(session, event("runtime_session_exited", { runtimeSessionId: "runtime-matrix" }));
  assert.ok(session);
  const cancelled = event("runtime_session_cancelled", { runtimeSessionId: "runtime-matrix" }),
    stoppedThenCancelled = reduceRuntimeSession(session, cancelled);
  assert.ok(stoppedThenCancelled);
  assert.equal(stoppedThenCancelled.outcome, null);
  assert.deepEqual(stoppedThenCancelled.cancelledBy, cancelled.actor);
  assert.equal(reduceRuntimeSession(stoppedThenCancelled, cancelled), stoppedThenCancelled);
  const cancelledFirst = reduceRuntimeSession(reduceRuntimeSession(null, started), cancelled)!,
    stop = getExecutableEntityAction("runtime_session_exited")!.execution!.compile!({
      ...compileInput,
      action: { kind: "runtime_session_exited", runtimeSessionId: "runtime-matrix" },
      currentEntity: cancelledFirst,
    });
  assert.equal(cancelledFirst.liveness, "exited");
  assert.equal(stop.kind, "runtime-session");
  assert.equal(stop.noChanges, undefined, "cancel is not a stop proof; the stop event must still be accepted");
  session = reduceRuntimeSession(
    session,
    event("runtime_session_task_bound", {
      runtimeSessionId: "runtime-matrix",
      taskId: "task-late",
      executionId: "execution-late",
      providerSessionId: "provider-a",
      transcriptRef: "file:runtime-transcripts/a.jsonl",
    }),
  );
  assert.ok(session);
  assert.equal(session.liveness, "exited");
  assert.equal(
    session.taskBindings.some((binding) => binding.taskId === "task-late"),
    true,
  );
  assert.equal(
    reduceRuntimeSession(
      session,
      event("runtime_session_outcome_observed", {
        runtimeSessionId: "runtime-matrix",
        outcome: "succeeded",
        exitCode: 0,
        resultRef: "artifact:runtime-result/a",
        result: null,
      }),
    )?.outcome,
    "succeeded",
  );
  const outcome = event("runtime_session_outcome_observed", {
    runtimeSessionId: "runtime-matrix",
    outcome: "succeeded",
    exitCode: 0,
    resultRef: "artifact:runtime-result/a",
    result: null,
  });
  session = reduceRuntimeSession(session, outcome);
  assert.ok(session);
  assert.equal(reduceRuntimeSession(session, outcome), session);
  assert.equal(
    getExecutableEntityAction("runtime_session_exited")!.execution!.compile!({
      ...compileInput,
      action: { kind: "runtime_session_exited", runtimeSessionId: session.runtimeSessionId },
      currentEntity: session,
    }).noChanges,
    true,
    "an accepted terminal outcome already includes the stop proof",
  );
  assert.throws(() =>
    reduceRuntimeSession(
      session,
      event("runtime_session_liveness_changed", { runtimeSessionId: "runtime-matrix", liveness: "live" }),
    ),
  );
  assert.throws(
    () =>
      reduceRuntimeSession(
        session,
        event("runtime_session_outcome_observed", { ...outcome.payload, reasonCode: "different" }),
      ),
    { name: "RuntimeSessionFieldConflictError" },
  );
  assert.equal(
    reduceRuntimeSession(session, event("runtime_session_cancelled", { runtimeSessionId: "runtime-matrix" })),
    session,
  );
});

test("RuntimeSession liveness carries the executing node's provider connectivity report and clears it", () => {
  const event = (type: AgentRuntimeEventV1["type"], payload: Record<string, unknown>) =>
    ({
      schema: "agent-runtime-event/v1",
      eventId: `event-${type}`,
      workspaceRevision: 1,
      opId: `request-${type}`,
      actor,
      source,
      occurredAt: compileInput.occurredAt,
      type,
      payload,
    }) as AgentRuntimeEventV1;
  let session = reduceRuntimeSession(
    null,
    event("runtime_session_started", {
      runtimeSessionId: "runtime-provider-report",
      instanceId: "instance-a",
      installationId: "installation-a",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/action-a",
      launchGeneration: 1,
      attachable: true,
    }),
  );
  assert.ok(session);
  const evidence = {
      state: "provider_unreachable",
      lastProgressAt: "2026-09-01T00:00:00.000Z",
      lastErrorAt: "2026-09-01T00:05:00.000Z",
      lastError: "Reconnecting... 5/5 (failed to connect to websocket: IO error: tls handshake eof)",
    },
    action = getExecutableEntityAction("runtime_session_liveness_changed");
  const draft = action?.execution?.compile?.({
    ...compileInput,
    currentEntity: session,
    action: {
      kind: "runtime_session_liveness_changed",
      runtimeSessionId: session.runtimeSessionId,
      liveness: "live",
      providerUnreachable: evidence,
    },
  });
  assert.equal(draft?.kind, "runtime-session");
  if (draft?.kind !== "runtime-session") return;
  assert.deepEqual(draft.event.payload, {
    runtimeSessionId: session.runtimeSessionId,
    liveness: "live",
    providerUnreachable: evidence,
  });
  session = reduceRuntimeSession(session, draft.event);
  assert.ok(session);
  assert.deepEqual(session.providerUnreachable, evidence);

  const cleared = action?.execution?.compile?.({
    ...compileInput,
    currentEntity: session,
    action: {
      kind: "runtime_session_liveness_changed",
      runtimeSessionId: session.runtimeSessionId,
      liveness: "live",
      providerUnreachable: null,
    },
  });
  assert.equal(cleared?.kind, "runtime-session");
  if (cleared?.kind !== "runtime-session") return;
  assert.equal(cleared.event.payload.providerUnreachable, null);
  const after = reduceRuntimeSession(session, cleared.event);
  assert.ok(after);
  assert.equal(after.providerUnreachable, null);
});

test("runtime outcome accepts a fallback plan only with a valid scheduled disposition", () => {
  const digest = sha256Text("");
  const payload = {
    runtimeSessionId: "fallback-contract",
    outcome: "failed",
    exitCode: 1,
    resultRef: `artifact:runtime-result/sha256/${digest}`,
    result: { sha256: digest, size: 0, mediaType: "text/plain; charset=utf-8" },
    attempt: {
      classification: "provider_fault",
      reason: "fixture",
      fallbackState: "scheduled",
      fallbackSchedule: {
        notBeforeAt: "2026-11-11T00:01:00.000Z",
        nextProvider: { instance: "provider-b", model: "model-b" },
      },
    },
  };
  assert.deepEqual(validateAgentRuntimePayload("runtime_session_outcome_observed", payload), []);
  for (const attempt of [
    { ...payload.attempt, fallbackState: "exhausted" },
    { ...payload.attempt, fallbackSchedule: { ...payload.attempt.fallbackSchedule, notBeforeAt: "tomorrow" } },
    { ...payload.attempt, fallbackSchedule: { ...payload.attempt.fallbackSchedule, nextProvider: { instance: "" } } },
    { ...payload.attempt, fallbackSchedule: { ...payload.attempt.fallbackSchedule, extra: "unknown" } },
  ])
    assert.match(
      validateAgentRuntimePayload("runtime_session_outcome_observed", { ...payload, attempt }).join(";"),
      /settlement metadata is invalid/u,
    );
});

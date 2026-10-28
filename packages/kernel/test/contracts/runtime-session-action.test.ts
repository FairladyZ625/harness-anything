// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  getExecutableEntityAction,
  sha256Text,
  type AgentRuntimeEventV1,
  type RuntimeSession,
} from "../../src/index.ts";
import { reduceRuntimeSession } from "../../src/domain/agent-runtime.ts";

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
  assert.equal(
    reduceRuntimeSession(session, event("runtime_session_cancelled", { runtimeSessionId: "runtime-matrix" }))?.outcome,
    null,
  );
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

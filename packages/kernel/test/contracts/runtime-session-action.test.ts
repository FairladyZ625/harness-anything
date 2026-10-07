// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { getExecutableEntityAction, sha256Text, type RuntimeSession } from "../../src/index.ts";

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

test("RuntimeSession start compiles the existing canonical event and rejects a stale adoption generation", () => {
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
      idempotencyKey: "start-a",
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
  assert.throws(
    () => action.execution!.compile!({ ...compileInput, action: command, currentEntity: current }),
    (error: unknown) => (error as { readonly code?: unknown }).code === "runtime_session_adoption_stale",
  );
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
        fallbackState: "exhausted",
      },
      resultBody: body,
      idempotencyKey: "outcome-a",
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
  const plain = { classification: "worker_stop", reason: "Stopped", fallbackState: null };
  assert.doesNotThrow(() =>
    action.execution!.compile!({ ...compileInput, action: { ...command, attempt: plain }, currentEntity: current }),
  );
  for (const attempt of [
    { ...command.attempt, faultClass: "other" },
    { ...command.attempt, resetAt: "tomorrow" },
    { ...command.attempt, fallbackState: "other" },
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

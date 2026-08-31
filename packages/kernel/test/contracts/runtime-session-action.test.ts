// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { getExecutableEntityAction, sha256Text, type RuntimeSession } from "../../src/index.ts";

const actor = { principal: { personId: "runtime-action" }, executor: null } as const;
const source = { kind: "assignment", nodeId: "edge-a", assignmentId: "assignment-a" } as const;
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
      resultBody: body,
      idempotencyKey: "outcome-a",
    };
  Object.assign(command, { resultRef: `artifact:runtime-result/sha256/${command.result.sha256}` });
  const draft = action?.execution?.compile?.({ ...compileInput, action: command, currentEntity: current });
  assert.equal(draft?.kind, "runtime-session");
  if (draft?.kind !== "runtime-session") return;
  assert.equal(draft.resultBody, body);
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

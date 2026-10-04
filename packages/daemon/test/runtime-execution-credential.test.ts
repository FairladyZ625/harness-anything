// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticateRuntimeExecutionCredential,
  issueRuntimeExecutionCredential,
  runtimeExecutionLifetimeMs,
  verifyRuntimeExecutionPrincipal,
} from "../src/runtime-execution-credential.ts";
import { requireCurrentExecutionScope, requireExecutionRequestScope } from "../src/runtime-execution-scope.ts";
import { fakeKeycloak } from "./keycloak.fixtures.ts";

const center = {
  url: "http://realm.invalid",
  realm: "harness",
  clientId: "harness-center",
  accessToken: "center-token",
};
const principal = () => ({
  personId: "person-worker",
  repoId: "repo",
  runtimeSessionId: "runtime-worker",
  dispatchId: "dispatch-worker",
  taskId: "task-worker",
  executionId: "execution-worker",
  role: "implementation" as const,
  source: "local" as const,
  expiresAt: new Date(Date.now() + runtimeExecutionLifetimeMs - 1000).toISOString(),
});

test("independent Keycloak client authenticates only its secret, expiry, and current enabled state", async () => {
  const realm = fakeKeycloak(),
    p = principal(),
    credential = await issueRuntimeExecutionCredential(center, p, realm.fetch);
  assert.deepEqual(await authenticateRuntimeExecutionCredential(center, credential, realm.fetch), p);
  await assert.rejects(
    authenticateRuntimeExecutionCredential(
      center,
      credential.slice(0, -1) + (credential.endsWith("A") ? "B" : "A"),
      realm.fetch,
    ),
    { code: "execution_credential_rejected" },
  );
  const response = await realm.fetch(
      `${center.url}/admin/realms/harness/clients?clientId=harness-execution-${p.dispatchId}`,
    ),
    [client] = await response.json();
  const edit = async (body: object) =>
    realm.fetch(`${center.url}/admin/realms/harness/clients/${client.id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  await edit({
    attributes: { harness_execution: JSON.stringify({ ...p, expiresAt: new Date(Date.now() - 1).toISOString() }) },
  });
  await assert.rejects(authenticateRuntimeExecutionCredential(center, credential, realm.fetch), {
    code: "execution_credential_rejected",
  });
  await edit({ enabled: false, attributes: { harness_execution: JSON.stringify(p) } });
  await assert.rejects(verifyRuntimeExecutionPrincipal(center, p, realm.fetch), {
    code: "execution_credential_rejected",
  });
  await assert.rejects(authenticateRuntimeExecutionCredential(center, credential, realm.fetch), {
    code: "execution_credential_rejected",
  });
  await assert.rejects(
    authenticateRuntimeExecutionCredential(center, credential, async () => {
      throw new Error("Keycloak offline");
    }),
    /Keycloak offline/u,
  );
});

test("execution requests exclude other tasks, repos, controls, and human consent", () => {
  const p = principal();
  const request = (kind: string, overrides = {}) =>
    requireExecutionRequestScope(p, "repo.task.read", {
      repo: { repoId: p.repoId },
      payload: { action: { kind, taskId: p.taskId, ...overrides } },
    });
  assert.doesNotThrow(() => request("task-show"));
  for (const kind of [
    "task-review-consent",
    "task-adjudicate",
    "task-list",
    "people-delegate",
    "task-review-execution",
  ])
    assert.throws(() => request(kind));
  assert.throws(() => request("task-show", { taskId: "task-other" }));
  assert.throws(() => requireExecutionRequestScope(p, "daemon.stop", {}));
  assert.throws(() =>
    requireExecutionRequestScope(p, "repo.task.read", {
      repo: { repoId: "other" },
      payload: { action: { kind: "task-show", taskId: p.taskId } },
    }),
  );
});

test("the writer rejects expired credentials, stopped or superseded dispatches, and a replaced lease", () => {
  const p = principal(),
    actor = {
      principal: { personId: p.personId },
      executor: { kind: "agent" as const, id: `runtime-session:${p.runtimeSessionId}` },
    };
  let liveness = "live",
    leaseActor = actor,
    dispatchId = p.dispatchId;
  const input = {
    action: { kind: "task-progress-append", taskId: p.taskId },
    binding: { executionPrincipal: p, actor, source: "local" as const },
    now: new Date().toISOString(),
    projection: {
      readRuntimeSession: () => ({
        liveness,
        outcome: null,
        taskBindings: [{ taskId: p.taskId, executionId: p.executionId }],
      }),
      readRuntimeDispatch: () => ({ actor, source: "local", payload: { dispatchId } }),
      currentLease: () => ({ phase: "held", actor: leaseActor, executionId: p.executionId, source: "local" }),
    } as never,
  };
  assert.doesNotThrow(() => requireCurrentExecutionScope(input));
  liveness = "exited";
  assert.throws(() => requireCurrentExecutionScope(input), { code: "execution_credential_rejected" });
  liveness = "live";
  dispatchId = "replacement";
  assert.throws(() => requireCurrentExecutionScope(input), { code: "execution_credential_rejected" });
  dispatchId = p.dispatchId;
  leaseActor = { ...actor, executor: { kind: "agent", id: "runtime-session:replacement" } };
  assert.throws(() => requireCurrentExecutionScope(input), { code: "execution_credential_rejected" });
  leaseActor = actor;
  assert.throws(
    () => requireCurrentExecutionScope({ ...input, now: new Date(Date.parse(p.expiresAt) + 1).toISOString() }),
    { code: "execution_credential_rejected" },
  );
});

test("queued node executions recheck current Keycloak node ownership", async () => {
  const realm = fakeKeycloak();
  realm.node("edge-one", "person-worker");
  const p = { ...principal(), source: { kind: "node" as const, nodeId: "edge-one" } };
  await issueRuntimeExecutionCredential(center, p, realm.fetch);
  await verifyRuntimeExecutionPrincipal(center, p, realm.fetch);
  realm.node("edge-one", "person-other");
  await assert.rejects(verifyRuntimeExecutionPrincipal(center, p, realm.fetch), {
    code: "execution_credential_rejected",
  });
});

test("edge settlement accepts its released lease but rejects cancellation, expiry and a foreign source", () => {
  const source = { kind: "node" as const, nodeId: "edge-one" };
  const p = { ...principal(), source },
    actor = { principal: { personId: p.personId }, executor: null };
  let outcome: string | null = null,
    phase = "held",
    submitted = false;
  const input = {
    action: {
      kind: "runtime-run",
      executionRuntimeIngress: {
        kind: "event",
        type: "runtime_session_outcome_observed",
        payload: { runtimeSessionId: p.runtimeSessionId, taskId: p.taskId, executionId: p.executionId },
      },
    },
    binding: { executionPrincipal: p, actor, source },
    now: new Date().toISOString(),
    projection: {
      readRuntimeSession: () => ({
        liveness: "exited",
        outcome,
        taskBindings: [{ taskId: p.taskId, executionId: p.executionId }],
      }),
      readRuntimeDispatch: () => ({ actor, source, payload: { dispatchId: p.dispatchId } }),
      currentLease: () => (phase === "held" ? { phase, actor, source, executionId: p.executionId } : null),
      read: () => ({
        snapshot: {
          lease: { phase, actor, source, executionId: p.executionId },
          executions: submitted ? [{ executionId: p.executionId, submission: {} }] : [],
        },
      }),
    } as never,
  };
  assert.doesNotThrow(() => requireCurrentExecutionScope(input));
  phase = "released";
  assert.doesNotThrow(() => requireCurrentExecutionScope(input));
  phase = "expired";
  assert.throws(() => requireCurrentExecutionScope(input), { code: "execution_credential_rejected" });
  submitted = true;
  assert.doesNotThrow(() => requireCurrentExecutionScope(input));
  assert.throws(
    () =>
      requireCurrentExecutionScope({
        ...input,
        binding: { ...input.binding, source: { kind: "node", nodeId: "edge-two" } },
      }),
    { code: "execution_credential_rejected" },
  );
  outcome = "cancelled";
  assert.throws(() => requireCurrentExecutionScope(input), { code: "execution_credential_rejected" });
});

test("stale reviewer can retire only its own failed or cancelled dispatch without business access", () => {
  const p = { ...principal(), role: "reviewer" as const, source: { kind: "node" as const, nodeId: "edge-one" } },
    actor = { principal: { personId: p.personId }, executor: null };
  let outcome: string | null = null;
  const input = {
    binding: { executionPrincipal: p, actor, source: p.source },
    now: new Date().toISOString(),
    projection: {
      readRuntimeSession: () => ({
        liveness: "active",
        outcome,
        taskBindings: [{ taskId: p.taskId, executionId: p.executionId }],
      }),
      readRuntimeDispatch: () => ({
        actor,
        source: p.source,
        payload: {
          dispatchId: p.dispatchId,
          role: "reviewer",
          reviewTarget: { kind: "task", taskId: p.taskId, executionId: p.executionId, digest: "old-cut" },
        },
      }),
      read: () => ({ snapshot: { executions: [{ executionId: p.executionId, submission: {} }] } }),
    } as never,
  };
  const event = (type: string, value?: string) => ({
    kind: "runtime-run",
    executionRuntimeIngress: {
      kind: "event",
      type,
      payload: { runtimeSessionId: p.runtimeSessionId, ...(value ? { outcome: value } : {}) },
    },
  });
  for (const action of [
    { kind: "task-show", taskId: p.taskId },
    { kind: "task-review-execution", taskId: p.taskId },
    {
      kind: "runtime-run",
      executionRuntimeIngress: { kind: "archive", archive: { runtimeSessionId: p.runtimeSessionId } },
    },
    event("runtime_session_outcome_observed", "succeeded"),
    event("runtime_session_outcome_observed", "unknown"),
  ])
    assert.throws(() => requireCurrentExecutionScope({ ...input, action }), { code: "execution_credential_rejected" });
  for (const action of [
    event("runtime_session_exited"),
    event("runtime_session_outcome_observed", "failed"),
    event("runtime_session_outcome_observed", "cancelled"),
  ]) {
    assert.doesNotThrow(() => requireCurrentExecutionScope({ ...input, action }));
    assert.throws(
      () =>
        requireCurrentExecutionScope({
          ...input,
          action,
          binding: { ...input.binding, source: { kind: "node", nodeId: "edge-two" } },
        }),
      { code: "execution_credential_rejected" },
    );
    assert.throws(() => requireCurrentExecutionScope({ ...input, action, now: p.expiresAt }), {
      code: "execution_credential_rejected",
    });
  }
  outcome = "cancelled";
  assert.doesNotThrow(() => requireCurrentExecutionScope({ ...input, action: event("runtime_session_exited") }));
  assert.doesNotThrow(() =>
    requireCurrentExecutionScope({ ...input, action: event("runtime_session_outcome_observed", "cancelled") }),
  );
  assert.throws(
    () => requireCurrentExecutionScope({ ...input, action: event("runtime_session_outcome_observed", "succeeded") }),
    { code: "execution_credential_rejected" },
  );
});

// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { submissionDigest } from "@harness-anything/kernel";
import {
  authenticateRuntimeExecutionPrincipal,
  issueRuntimeExecutionCredential,
  readRuntimeExecutionPrincipal,
  executionCredentialRejected,
} from "../src/runtime-execution-credential.ts";
import { requireCurrentExecutionScope } from "../src/runtime-execution-scope.ts";
import { dispatchLifecycleReadOf, lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";
import { center, principal, executionLifecycle } from "./runtime-execution-credential.fixtures.ts";
import { fakeKeycloak } from "./keycloak.fixtures.ts";

test("a cold center token before runtime execution authentication is a retryable identity outage", async () => {
  const cold = Object.assign(new Error("Keycloak could not be reached to acquire a center token."), {
    code: "daemon_error",
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
  await assert.rejects(
    authenticateRuntimeExecutionPrincipal(async () => {
      throw cold;
    }, "harness-execution-dispatch-worker:secret"),
    (error: Error & { readonly code?: string }) => {
      assert.equal(error.code, "keycloak_unavailable");
      assert.match(error.message, /authenticating the runtime execution credential/u);
      assert.equal(error.cause, cold);
      return true;
    },
  );
});

test("expired credentials block worker writes with exact reason while hostSettlement permits physical exit and liveness/archive settlement", async () => {
  const realm = fakeKeycloak(),
    p = {
      ...principal(),
      role: "reviewer" as const,
      source: { kind: "node" as const, nodeId: "edge-one" },
      expiresAt: "2020-01-01T00:00:00.000Z",
    },
    implPrincipal = {
      ...principal(),
      dispatchId: "dispatch_222222222222222222222222",
      runtimeSessionId: "runtime_222222222222222222222222",
      role: "implementation" as const,
      source: { kind: "node" as const, nodeId: "edge-one" },
      expiresAt: "2020-01-01T00:00:00.000Z",
    };
  realm.node("edge-one", p.personId);
  await issueRuntimeExecutionCredential(center, p, realm.fetch);
  await issueRuntimeExecutionCredential(center, implPrincipal, realm.fetch);

  await assert.rejects(
    readRuntimeExecutionPrincipal(center, p.dispatchId, realm.fetch),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "execution_credential_rejected" &&
      /expired at 2020-01-01T00:00:00\.000Z/u.test(error.message) &&
      !/from-file/iu.test(error.message),
  );
  const settledPrincipal = await readRuntimeExecutionPrincipal(center, p.dispatchId, realm.fetch, {
    hostSettlement: true,
  });
  assert.equal(settledPrincipal.dispatchId, p.dispatchId);

  const actor = { principal: { personId: p.personId }, executor: null };
  let outcome: string | null = null;
  let liveness = "active";
  let reviewDigest = "old-cut";
  const baseProjection = {
    readDispatchLifecycle(query: Parameters<typeof executionLifecycle>[1]) {
      return executionLifecycle(this, query);
    },
    readRuntimeSession: () => ({
      liveness,
      outcome,
      taskBindings: [{ taskId: p.taskId, executionId: p.executionId }],
    }),
    readRuntimeDispatch: () => ({
      actor,
      source: p.source,
      payload: {
        dispatchId: p.dispatchId,
        role: "reviewer",
        reviewTarget: { kind: "task", taskId: p.taskId, executionId: p.executionId, digest: reviewDigest },
      },
    }),
    read: () => ({ snapshot: { executions: [{ executionId: p.executionId, submission: {} }] } }),
  } as never;

  const baseBinding = { executionPrincipal: p, actor, source: p.source };
  const implBinding = { executionPrincipal: implPrincipal, actor, source: implPrincipal.source };
  const implProjection = {
    readDispatchLifecycle(query: Parameters<typeof executionLifecycle>[1]) {
      return executionLifecycle(this, query);
    },
    readRuntimeSession: () => ({
      liveness: "exited",
      outcome: null,
      taskBindings: [{ taskId: implPrincipal.taskId, executionId: implPrincipal.executionId }],
    }),
    readRuntimeDispatch: () => ({
      actor,
      source: implPrincipal.source,
      payload: { dispatchId: implPrincipal.dispatchId, role: "implementation" },
    }),
    read: () => ({ snapshot: { executions: [{ executionId: implPrincipal.executionId, submission: {} }] } }),
  } as never;
  const now = "2026-01-01T00:00:00.000Z";
  // Worker business write still fails expiry even when requested after expiresAt.
  assert.throws(
    () =>
      requireCurrentExecutionScope({
        action: { kind: "task-progress-append", taskId: implPrincipal.taskId },
        binding: implBinding,
        projection: implProjection,
        now,
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "execution_credential_rejected" &&
      error.message.includes(`dispatch ${implPrincipal.dispatchId}`),
  );
  assert.doesNotThrow(() =>
    requireCurrentExecutionScope({
      action: {
        kind: "runtime-run",
        executionRuntimeIngress: {
          kind: "event",
          type: "runtime_session_exited",
          payload: { runtimeSessionId: implPrincipal.runtimeSessionId },
        },
      },
      binding: implBinding,
      projection: implProjection,
      now,
      hostSettlement: true,
    }),
  );
  // Physical negative terminal facts survive expiry and a superseded review cut.
  for (const action of [
    {
      kind: "runtime-run",
      executionRuntimeIngress: {
        kind: "event",
        type: "runtime_session_exited",
        payload: { runtimeSessionId: p.runtimeSessionId },
      },
    },
    {
      kind: "runtime-run",
      executionRuntimeIngress: {
        kind: "event",
        type: "runtime_session_outcome_observed",
        payload: { runtimeSessionId: p.runtimeSessionId, outcome: "failed" },
      },
    },
  ]) {
    assert.doesNotThrow(() =>
      requireCurrentExecutionScope({
        action,
        binding: baseBinding,
        projection: baseProjection,
        now,
        hostSettlement: true,
      }),
    );
  }
  const abandonment = {
    kind: "runtime-run",
    executionRuntimeIngress: {
      kind: "event",
      type: "runtime_session_outcome_observed",
      payload: {
        runtimeSessionId: p.runtimeSessionId,
        dispatchId: p.dispatchId,
        outcome: "unknown",
        exitCode: null,
        reasonCode: "ruling_resolved",
      },
    },
  };
  const ownerAbandonment = {
    action: abandonment,
    binding: baseBinding,
    projection: baseProjection,
    now,
    hostSettlement: true,
  };
  assert.doesNotThrow(() => requireCurrentExecutionScope(ownerAbandonment));
  assert.throws(
    () =>
      requireCurrentExecutionScope({
        ...ownerAbandonment,
        binding: {
          ...baseBinding,
          actor: { ...actor, executor: { kind: "agent", id: `runtime-session:${p.runtimeSessionId}` } },
        },
      }),
    { code: "execution_credential_rejected" },
  );
  // Archive still requires the current submitted cut, even during host settlement.
  reviewDigest = submissionDigest({} as never);
  // Cancelled dispatch admits archive cleanup alongside negativeTerminal, while rejecting liveness updates.
  outcome = "cancelled";
  assert.doesNotThrow(() =>
    requireCurrentExecutionScope({
      action: {
        kind: "runtime-run",
        executionRuntimeIngress: {
          kind: "archive",
          archive: { runtimeSessionId: p.runtimeSessionId, taskId: p.taskId, executionId: p.executionId },
        },
      },
      binding: baseBinding,
      projection: baseProjection,
      now,
      hostSettlement: true,
    }),
  );
  assert.throws(
    () =>
      requireCurrentExecutionScope({
        action: {
          kind: "runtime-run",
          executionRuntimeIngress: {
            kind: "event",
            type: "runtime_session_liveness_changed",
            payload: { runtimeSessionId: p.runtimeSessionId, liveness: "unknown" },
          },
        },
        binding: baseBinding,
        projection: baseProjection,
        now,
        hostSettlement: true,
      }),
    { code: "execution_credential_rejected" },
  );
  // Before cancellation, liveness_changed during settling adoption (after runtime_session_cancelled) is admitted.
  outcome = null;
  liveness = "settling";
  const settlingProjection = {
    ...(baseProjection as object),
    readDispatchLifecycle(query: { readonly runtimeSessionId: string }) {
      const dispatch = (baseProjection as { readRuntimeDispatch: (id: string) => any }).readRuntimeDispatch(
          query.runtimeSessionId,
        ),
        options = { source: dispatch.source, instanceId: "fixture", dispatchId: p.dispatchId };
      return dispatchLifecycleReadOf(() => [
        lifecycleEvent("R", query.runtimeSessionId, options),
        lifecycleEvent("S", query.runtimeSessionId, options),
        lifecycleEvent("C", query.runtimeSessionId, options),
      ])(query as never);
    },
  } as never;
  assert.doesNotThrow(() =>
    requireCurrentExecutionScope({
      action: {
        kind: "runtime-run",
        executionRuntimeIngress: {
          kind: "event",
          type: "runtime_session_liveness_changed",
          payload: { runtimeSessionId: p.runtimeSessionId, liveness: "unknown" },
        },
      },
      binding: baseBinding,
      projection: settlingProjection,
      now,
      hostSettlement: true,
    }),
  );

  // Accurate diagnostics on executionCredentialRejected for expired/revoked reviewer credentials.
  const revokedErr = executionCredentialRejected("revoked", { role: "reviewer", dispatchId: p.dispatchId });
  assert.match(revokedErr.message, /revoked/u);
  assert.doesNotMatch(revokedErr.message, /expired|--from-file/u);
  const expiredErr = executionCredentialRejected("expired", {
    role: "reviewer",
    dispatchId: p.dispatchId,
    expiresAt: p.expiresAt,
  });
  assert.match(expiredErr.message, /expired at 2020-01-01T00:00:00\.000Z/u);
  assert.doesNotMatch(expiredErr.message, /--from-file/u);
});

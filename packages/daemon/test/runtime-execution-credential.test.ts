// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authenticateRuntimeExecutionCredential,
  issueRuntimeExecutionCredential,
  runtimeExecutionLifetimeMs,
  verifyRuntimeExecutionPrincipal,
} from "../src/runtime-execution-credential.ts";
import {
  requireCurrentExecutionScope,
  requireExecutionRequestScope,
  requireExecutionActionScope,
} from "../src/runtime-execution-scope.ts";
import { executeRepoAction } from "../src/repo-cell-action-dispatch.ts";
import { bindVerifiedExecutorClaim } from "../src/repo-cell-authorization.ts";
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
    { code: "execution_credential_rejected", message: "Execution credential authentication was rejected." },
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
    message: "Execution credential is expired.",
  });
  await edit({ enabled: false, attributes: { harness_execution: JSON.stringify(p) } });
  await assert.rejects(verifyRuntimeExecutionPrincipal(center, p, realm.fetch), {
    code: "execution_credential_rejected",
    message: "Execution credential is revoked.",
  });
  await assert.rejects(authenticateRuntimeExecutionCredential(center, credential, realm.fetch), {
    code: "execution_credential_rejected",
    message: "Execution credential is revoked.",
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
    requireExecutionRequestScope(
      p,
      kind === "task-push" || kind === "ci-observe-pull" ? "repo.task.run" : "repo.task.read",
      {
        repo: { repoId: p.repoId },
        payload: { action: { kind, taskId: p.taskId, ...overrides } },
      },
    );
  assert.doesNotThrow(() => request("task-show"));
  assert.doesNotThrow(() => request("task-ci"));
  assert.doesNotThrow(() =>
    requireExecutionActionScope({ ...p, role: "reviewer" }, { kind: "task-ci", taskId: p.taskId }),
  );
  assert.throws(() => request("task-ci", { taskId: "task-other" }), { code: "execution_credential_rejected" });
  assert.throws(
    () => requireExecutionActionScope({ ...p, role: "reviewer" }, { kind: "task-ci", taskId: "task-other" }),
    { code: "execution_credential_rejected" },
  );
  assert.doesNotThrow(() => request("task-push"));
  assert.doesNotThrow(() => request("ci-observe-pull", { taskId: p.taskId }));
  assert.throws(() => request("ci-observe-pull", { taskId: undefined }));
  assert.throws(() => request("ci-observe-pull", { taskId: p.taskId, limit: 1 }));
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

test("task identity may request its own task scope but cannot decide or administer permissions", () => {
  const p = principal(),
    params = {
      operation: "permission-request-create",
      repoId: p.repoId,
      resource: `${p.repoId}:task/${p.taskId}`,
      groupId: "viewer",
    };
  assert.doesNotThrow(() => requireExecutionRequestScope(p, "daemon.rbac.manage", params));
  for (const extra of [
    { repoId: "another" },
    { resource: p.repoId },
    { resource: `${p.repoId}:task/another` },
    { personId: "another" },
    { operation: "permission-request-decide" },
    { operation: "grant" },
    { operation: "permission-request-list" },
    { operation: "device-resume" },
    { mode: "external" },
  ])
    assert.throws(() => requireExecutionRequestScope(p, "daemon.rbac.manage", { ...params, ...extra }), {
      code: "execution_credential_rejected",
    });
test("execution credentials allow repository settings and only the dispatched decision review target", () => {
  const p = { ...principal(), role: "reviewer" as const, reviewDecisionId: "dec_bound" };
  assert.doesNotThrow(() =>
    requireExecutionRequestScope(p, "repo.settings.read", { repo: { repoId: p.repoId }, payload: {} }),
  );
  assert.doesNotThrow(() => requireExecutionActionScope(p, { kind: "decision-show", decisionId: "dec_bound" }));
  assert.throws(() => requireExecutionActionScope(p, { kind: "decision-show", decisionId: "dec_other" }), {
    code: "execution_credential_rejected",
  });
  assert.throws(() => requireExecutionActionScope(p, { kind: "settings-update" }), {
    code: "execution_credential_rejected",
  });
  assert.throws(
    () =>
      requireExecutionActionScope(
        { ...p, reviewDecisionId: undefined },
        { kind: "decision-show", decisionId: "dec_bound" },
      ),
    {
      code: "execution_credential_rejected",
    },
  );
});

test("the writer accepts only the decision bound to a live decision-review dispatch", () => {
  const p = { ...principal(), role: "reviewer" as const, reviewDecisionId: "dec_bound" },
    actor = {
      principal: { personId: p.personId },
      executor: { kind: "agent" as const, id: `runtime-session:${p.runtimeSessionId}` },
    },
    input = {
      action: { kind: "decision-show", decisionId: "dec_bound" },
      binding: { executionPrincipal: p, actor, source: "local" as const },
      now: new Date().toISOString(),
      projection: {
        read: () => ({ snapshot: { executions: [] } }),
        readRuntimeSession: () => ({
          liveness: "live",
          outcome: null,
          taskBindings: [{ taskId: p.taskId, executionId: p.executionId }],
        }),
        readRuntimeDispatch: () => ({
          actor,
          source: "local",
          payload: {
            dispatchId: p.dispatchId,
            role: "reviewer",
            reviewTarget: { kind: "decision", decisionId: "dec_bound" },
          },
        }),
        currentLease: () => null,
      } as never,
    };
  assert.doesNotThrow(() => requireCurrentExecutionScope(input));
  assert.doesNotThrow(() =>
    requireExecutionRequestScope(p, "repo.task.read", {
      repo: { repoId: p.repoId },
      payload: { action: { kind: "decision-show", decisionId: "dec_bound" } },
    }),
  );
  assert.throws(
    () =>
      requireExecutionRequestScope(p, "repo.task.read", {
        repo: { repoId: p.repoId },
        payload: { action: { kind: "decision-show", decisionId: "dec_other" } },
      }),
    { code: "execution_credential_rejected" },
  );
  assert.throws(
    () => requireCurrentExecutionScope({ ...input, action: { kind: "decision-show", decisionId: "dec_other" } }),
    { code: "execution_credential_rejected" },
  );
  assert.throws(
    () =>
      requireCurrentExecutionScope({
        ...input,
        binding: { ...input.binding, executionPrincipal: { ...p, reviewDecisionId: "dec_other" } },
      }),
    { code: "execution_credential_rejected" },
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

test("a live worker may publish and read CI after submission releases the lease", () => {
  const p = principal();
  let liveness = "live";
  const actor = {
      principal: { personId: p.personId },
      executor: { kind: "agent" as const, id: `runtime-session:${p.runtimeSessionId}` },
    },
    action = {
      kind: "task-push",
      taskId: p.taskId,
      executor: actor.executor,
    },
    projection = {
      read: () => ({
        snapshot: { executions: [{ executionId: p.executionId, submission: { commitSha: "a".repeat(40) } }] },
      }),
      readRuntimeSession: () => ({
        liveness,
        outcome: null,
        taskBindings: [{ taskId: p.taskId, executionId: p.executionId }],
      }),
      readRuntimeDispatch: () => ({ actor, source: "local", payload: { dispatchId: p.dispatchId } }),
      currentLease: () => null,
    } as never,
    input = {
      action,
      binding: { executionPrincipal: p, actor, source: "local" as const },
      projection,
      now: new Date().toISOString(),
    };
  assert.doesNotThrow(() => requireCurrentExecutionScope(input));
  assert.doesNotThrow(() => bindVerifiedExecutorClaim(input));
  const ci = { ...input, action: { kind: "task-ci", taskId: p.taskId } };
  assert.doesNotThrow(() => requireCurrentExecutionScope(ci));
  assert.throws(() => requireCurrentExecutionScope({ ...ci, action: { kind: "task-ci", taskId: "task-other" } }), {
    code: "execution_credential_rejected",
  });
  assert.throws(
    () => requireCurrentExecutionScope({ ...input, action: { kind: "task-progress-append", taskId: p.taskId } }),
    {
      code: "execution_credential_rejected",
    },
  );
  liveness = "exited";
  assert.throws(() => requireCurrentExecutionScope(ci), { code: "execution_credential_rejected" });
  assert.throws(() => bindVerifiedExecutorClaim(input), { code: "execution_credential_rejected" });
  assert.throws(() => bindVerifiedExecutorClaim({ ...input, action: { ...action, taskId: "task-other" } }), {
    code: "execution_credential_rejected",
  });
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

test("execution event list permits repository reads without widening task or write scope", () => {
  for (const role of ["implementation", "reviewer"] as const) {
    for (const source of ["local", { kind: "node", nodeId: "edge-one" }] as const) {
      const p = { ...principal(), role, source };
      const request = (repoId: string, action: object) =>
        requireExecutionRequestScope(p, "repo.task.read", { repo: { repoId }, payload: { action } });
      assert.doesNotThrow(() =>
        request(p.repoId, {
          kind: "event-list",
          type: "runtime_session_outcome_observed",
          before: "2026-10-09T06:06:00Z",
          limit: 100,
        }),
      );
      assert.throws(() => request("other-repo", { kind: "event-list" }), {
        code: "execution_credential_rejected",
        message:
          "Execution request is outside its dispatch scope. Allowed reads: this task, repository settings, and the dispatched review target; use `ha task read-set <task-id>`, `ha settings read`, or `ha decision show <id>` for the bound target.",
      });
      for (const action of [
        { kind: "event-show", opId: "other-event" },
        { kind: "task-show", taskId: "other-task" },
        { kind: "task-progress-append", taskId: "other-task" },
        { kind: "task-adjudicate", taskId: p.taskId },
        { kind: "relation-relate", taskId: p.taskId },
      ])
        assert.throws(() => requireExecutionActionScope(p, action), {
          code: "execution_credential_rejected",
          message:
            "Execution request is outside its dispatch scope. Allowed reads: this task, repository settings, and the dispatched review target; use `ha task read-set <task-id>`, `ha settings read`, or `ha decision show <id>` for the bound target.",
        });
    }
  }
});

test("reviewer frozen document requests use a path without granting catalog reads", () => {
  const p = { ...principal(), role: "reviewer" as const };
  const action = { kind: "doc-show", path: "tasks/task-worker/artifacts/report.md", raw: true };
  assert.doesNotThrow(() =>
    requireExecutionRequestScope(p, "repo.task.read", {
      repo: { repoId: p.repoId },
      payload: { action },
    }),
  );
  for (const denied of [
    { ...action, taskId: "task-other" },
    { ...action, paths: [action.path] },
    { ...action, all: true },
    { ...action, executionId: "execution-other" },
  ])
    assert.throws(() => requireExecutionActionScope(p, denied), { code: "execution_credential_rejected" });
  assert.throws(() => requireExecutionActionScope(p, { kind: "preset-list" }), {
    code: "execution_credential_rejected",
  });
});

test("implementers read the preset catalog and their own documents without gaining writes (dec_9DFDC635180975FDFC0CDB33D7)", () => {
  const p = principal();
  const request = (method: string, payload: object, repoId = p.repoId) =>
    requireExecutionRequestScope(p, method, { repo: { repoId }, payload });
  for (const [method, payload] of [
    ["repo.preset.list", { verticalId: "software/coding" }],
    ["repo.preset.inspect", { presetId: "standard-task", verticalId: "software/coding" }],
    ["repo.vertical.validate", { verticalSource: "verticals/ai4s" }],
    ["repo.preset.check", { presetId: "standard-task" }],
    ["repo.preset.audit", {}],
    ["repo.template.list", {}],
    ["repo.script.list", {}],
  ] as const)
    assert.doesNotThrow(() => request(method, payload));
  assert.doesNotThrow(() =>
    request("repo.task.read", { action: { kind: "doc-show", path: "tasks/task-worker/artifacts/report.md" } }),
  );
  // Catalog reads stay inside the dispatch's repository and away from the write lifecycle.
  assert.throws(() => request("repo.preset.list", {}, "other-repo"), { code: "execution_credential_rejected" });
  for (const action of [
    { kind: "preset-install", packageSource: "pkg" },
    { kind: "preset-seed" },
    { kind: "preset-upgrade", taskId: p.taskId },
    { kind: "script-run", scriptId: "vertical:a:b" },
    { kind: "task-create", title: "x" },
  ])
    assert.throws(() => requireExecutionActionScope(p, action), { code: "execution_credential_rejected" });
  // The gate passes document reads without a task binding; the doc-sync read owns the path bound.
  assert.throws(
    () => requireExecutionActionScope(p, { kind: "doc-show", path: "tasks/task-worker/x.md", taskId: "task-other" }),
    { code: "execution_credential_rejected" },
  );
});

test("execution credentials keep validator sources inside the dispatched repository", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-source-scope-"));
  try {
    const cell = {
        rootDir,
        cellCodedError: (code: string, text: string) => Object.assign(new Error(text), { code }),
        settings: {
          read: () => ({
            defaultVertical: "software/coding",
            defaultPreset: "standard-task",
            locale: "en-US",
            scaffolds: { task: "t", repository: "r" },
            ci: { workflows: [] },
          }),
        },
        store: { readHead: () => null },
        projection: { readCut: () => ({ status: "ready", watermark: 1 }) },
        operationId: () => "op",
        input: { repoId: "repo" },
      } as never,
      principalBinding = {
        actor: { principal: { personId: "person-worker" }, executor: null },
        source: "local" as const,
        executionPrincipal: principal(),
      },
      localBinding = { actor: { principal: { personId: "person-worker" } }, source: "local" as const },
      validate = async (binding: object, verticalSource: string) =>
        executeRepoAction(cell, { kind: "vertical-validate", verticalSource } as never, binding as never);
    for (const outside of ["../neighbor/vertical.json", "/etc/vertical.json"])
      await assert.rejects(validate(principalBinding, outside), { code: "execution_credential_rejected" });
    // The same source stays reachable for the repository's own local principals.
    const receipt = (await validate(localBinding, "/etc/vertical.json")) as { readonly outcome: string };
    assert.equal(receipt.outcome, "applied");
    // Inside the repository the validator runs and reports availability itself.
    assert.equal(
      ((await validate(principalBinding, "verticals/none")) as { readonly outcome: string }).outcome,
      "applied",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

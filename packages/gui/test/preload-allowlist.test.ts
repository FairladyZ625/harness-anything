// harness-test-tier: contract
import { parseAgentDeclarationV1 } from "@harness-anything/kernel/internal/domain/agent-squad-schema.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { daemonActionRoutes, interactiveRpcMethods, validateDaemonRpcCall } from "@harness-anything/daemon/client";
import { HARNESS_PRELOAD_API, assertRendererRpc } from "../src/index.ts";
import { interactiveRpcDescriptor, scopedRpcParams } from "@harness-anything/daemon/protocol";
import {
  buildRuntimeInstanceCreatePayload,
  type CreateInstanceFormState,
} from "../src/renderer/runtime-instance-form.ts";

function assertPreloadPayload(method: string, input: unknown): true {
  const descriptor = interactiveRpcDescriptor(method);
  if (!descriptor || Array.isArray(input) || (input !== null && typeof input !== "object"))
    return assertRendererRpc(method, input);
  return assertRendererRpc(descriptor.method, scopedRpcParams(descriptor.method, input ?? {}));
}
const preloadAllowlist: readonly string[] = interactiveRpcMethods.map(({ method }) => method);
const isAllowedPreloadApiMethod = (method: string) => interactiveRpcDescriptor(method) !== undefined;

const runtimeCreateForm: CreateInstanceFormState = {
  instanceId: "claude-one",
  name: "Claude one",
  kindId: "claude",
  installationId: "claude-install",
  providerId: "anthropic",
  model: "claude-opus",
  reasoningEffort: "",
  fast: false,
  baseUrl: "",
  authMode: "subscription",
  apiKey: "",
  wireApi: "",
  requiresOpenAiAuth: false,
  permissionMode: "bypass",
  isolation: "operator-environment",
};

// harness-contract: gui.preload-allowlist
test("preload exposes only the approved API methods", () => {
  assert.equal(HARNESS_PRELOAD_API, "harness");
  assert.equal(new Set(preloadAllowlist).size, preloadAllowlist.length);
  assert.equal(isAllowedPreloadApiMethod("repo.tasks.list"), true);
  assert.equal(isAllowedPreloadApiMethod("getTaskDetail"), false);
  assert.equal(isAllowedPreloadApiMethod("repo.task.show"), true);
  assert.equal(isAllowedPreloadApiMethod("repo.task.rework"), true);
  assert.equal(isAllowedPreloadApiMethod("repo.task.materialize"), true);
  assert.equal(assertPreloadPayload("repo.task.materialize", { repoId: "repo-a", taskId: "task-a" }), true);
  assert.throws(() => assertPreloadPayload("repo.task.materialize", { repoId: "repo-a" }), /invalid/u);
  assert.throws(
    () => assertPreloadPayload("repo.task.materialize", { repoId: "repo-a", taskId: "task-a", all: true }),
    /invalid/u,
  );
  assert.throws(() => assertPreloadPayload("readFile", {}), /not allowed/u);
  assert.throws(() => assertPreloadPayload("repo.tasks.list", []), /invalid/u);
  assert.throws(() => assertPreloadPayload("repo.tasks.list", null), /repoId/u);
  assert.throws(() => assertPreloadPayload("repo.tasks.list", {}), /repoId/u);
  assert.throws(() => assertPreloadPayload("repo.tasks.list", { repoId: "" }), /repoId/u);
  assert.equal(assertPreloadPayload("repo.tasks.list", { repoId: "repo-a" }), true);
  assert.equal(assertPreloadPayload("repo.decisions.list", { repoId: "repo-a", state: "proposed" }), true);
  assert.equal(assertPreloadPayload("repo.decisions.list", { repoId: "repo-a", state: "outcome_retired" }), true);
  assert.throws(() => assertPreloadPayload("repo.decisions.list", { repoId: "repo-a", state: "unknown" }), /invalid/u);
  assert.equal(assertPreloadPayload("repo.settings.read", { repoId: "repo-a" }), true);
  assert.equal(
    assertPreloadPayload("repo.settings.update", {
      repoId: "repo-a",
      defaultPreset: "strict-task",
      locale: "zh-CN",
      expectedVersion: 42,
      idempotencyKey: "settings-1",
    }),
    true,
  );
  assert.throws(
    () => assertPreloadPayload("repo.settings.update", { repoId: "repo-a", idempotencyKey: "settings-1" }),
    /invalid/u,
  );
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.settings.update",
      params: {
        repo: { repoId: "repo-a" },
        payload: { idempotencyKey: "settings-1" },
      },
    }),
    ["settings update is invalid"],
  );
  assert.equal(
    assertPreloadPayload("repo.tasks.list", {
      repoId: "repo-a",
      status: "active",
      changedAfterRevision: 42,
      limit: 50,
    }),
    true,
  );
  assert.equal(
    assertPreloadPayload("repo.triadic.relationGraph", {
      repoId: "repo-a",
      updatedAfter: "2026-08-01T00:00:00.000Z",
      cursor: "eAo",
    }),
    true,
  );
  // The renderer pages the edges facet (task_249009a7a7978b203cfe7177fd): a page window travels
  // with the facet exactly as the daemon's own validator admits it, and the daemon's closure still
  // rejects legacy list fields or a page window on a facet that has none.
  assert.equal(
    assertPreloadPayload("repo.triadic.relationGraph", {
      repoId: "repo-a",
      facet: "edges",
      state: "active",
      limit: 500,
      cursor: "eAo",
    }),
    true,
  );
  assert.throws(
    () => assertPreloadPayload("repo.triadic.relationGraph", { repoId: "repo-a", facet: "edges", status: "active" }),
    /params are invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("repo.triadic.relationGraph", { repoId: "repo-a", facet: "coverageRows", limit: 5 }),
    /params are invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("repo.triadic.relationGraph", { repoId: "repo-a", facet: "edges", limit: 0 }),
    /params are invalid/u,
  );
  // Slice A: the entity page selector travels through the same daemon validator — no hand-copied
  // field table in preload. `entity` with a page window is valid; `hops` stays neighborhood-only.
  assert.equal(
    assertPreloadPayload("repo.triadic.relationGraph", { repoId: "repo-a", entity: "decision/dec_1", limit: 500 }),
    true,
  );
  assert.throws(
    () =>
      assertPreloadPayload("repo.triadic.relationGraph", {
        repoId: "repo-a",
        entity: "decision/dec_1",
        facet: "edges",
      }),
    /params are invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("repo.triadic.relationGraph", { repoId: "repo-a", entity: "" }),
    /params are invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("repo.triadic.relationGraph", { repoId: "repo-a", entity: "decision/dec_1", hops: {} }),
    /params are invalid/u,
  );
  assert.equal(assertPreloadPayload("repo.task.dispatches", { repoId: "repo-a", taskId: "task-a" }), true);
  assert.equal(
    assertPreloadPayload("repo.task.dispatches", {
      repoId: "repo-a",
      taskId: "task-a",
      advisorySurface: "gui.dispatch",
    }),
    true,
  );
  assert.equal(
    assertPreloadPayload("repo.task.dispatches", {
      repoId: "repo-a",
      taskId: "task-a",
      advisorySurface: "agenda",
    }),
    true,
  );
  assert.equal(
    assertPreloadPayload("repo.task.dispatches", { repoId: "repo-a", taskIds: ["task-a", "task-b"], limit: 2 }),
    true,
  );
  assert.throws(
    () => assertPreloadPayload("repo.task.dispatches", { repoId: "repo-a", taskId: "task-a", taskIds: ["task-b"] }),
    /invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("repo.task.dispatches", { repoId: "repo-a", taskIds: ["task-a", "task-a"] }),
    /invalid/u,
  );
  // The member read is the GUI's recent-sessions path: one executor plus the window size, no
  // task list. The preload must admit the same shape the daemon validates, or the read dies at
  // the renderer→preload boundary before it ever reaches the daemon.
  assert.equal(assertPreloadPayload("repo.task.dispatches", { repoId: "repo-a", agentId: "agent-a", limit: 50 }), true);
  assert.equal(assertPreloadPayload("repo.task.dispatches", { repoId: "repo-a", squadId: "squad-a", limit: 50 }), true);
  assert.throws(
    () =>
      assertPreloadPayload("repo.task.dispatches", {
        repoId: "repo-a",
        agentId: "agent-a",
        squadId: "squad-a",
        limit: 50,
      }),
    /invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("repo.task.dispatches", { repoId: "repo-a", agentId: "agent-a" }),
    /invalid/u,
  );
  assert.throws(() => assertPreloadPayload("repo.tasks.list", { repoId: "repo-a", limit: 0 }), /params are invalid/u);
  assert.throws(
    () => assertPreloadPayload("repo.tasks.list", { repoId: "repo-a", changedAfterRevision: -1 }),
    /params are invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("repo.tasks.list", { repoId: "repo-a", changedAfterRevision: 1.5 }),
    /params are invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("repo.triadic.relationGraph", { repoId: "repo-a", changedAfterRevision: 42 }),
    /params are invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("repo.triadic.relationGraph", { repoId: "repo-a", updatedBefore: "not-a-date" }),
    /params are invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("repo.tasks.list", { repoId: "repo-a", status: "edge_retired" }),
    /params are invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("repo.triadic.relationGraph", { repoId: "repo-a", status: "blocked" }),
    /params are invalid/u,
  );
  assert.equal(assertPreloadPayload("daemon.runtimeInstance.list", { all: true }), true);
  assert.equal(assertPreloadPayload("daemon.runtimeInstance.show", { instanceId: "codex-review", probe: true }), true);
  assert.throws(() => assertPreloadPayload("daemon.runtimeInstance.list", null), /invalid/u);
  assert.equal(isAllowedPreloadApiMethod("reauthRuntimeInstance"), false);
  assert.equal(
    assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "codex-review", enabled: false }),
    true,
  );
  assert.equal(
    assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "codex-review", permissionMode: "read-only" }),
    true,
  );
  assert.equal(
    assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "claude-review", isolationState: "enforced" }),
    true,
  );
  assert.equal(
    assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "claude-review", effort: "xhigh" }),
    true,
  );
  assert.equal(
    assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "claude-review", effort: "" }),
    true,
  );
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "claude-review", effort: 5 }),
    /invalid/u,
  );
  assert.throws(
    () =>
      assertPreloadPayload("daemon.runtimeInstance.update", {
        instanceId: "codex-review",
        enabled: false,
        authMode: "api-key",
      }),
    /invalid/u,
  );
  assert.throws(() => assertPreloadPayload("repo.tasks.list", { repoId: "repo-a", staleRepoId: "repo-b" }), /invalid/u);
  assert.throws(() => assertPreloadPayload("daemon.gui.system.read", { repoId: "repo-a" }), /invalid/u);
  // 62 explicit actions plus the complete declaration read are the 63 editing-facing facets
  // task adjudication (owner triage/verdict) and the owner's review consent joined as named
  // facets alongside complete; retireRelation answers an awaits ask in place
  // (dec_DF67F23066BAFE444190A191B5, task_ec805e49); Decision review responds, overrides,
  // dispatches, and reads the report through its center document (dec_A64B14D6B7DDCF6A459CCC7A00);
  // agent retire/delete and squad delete are named ingresses onto the CLI entity actions
  // (task_3c098ffe: GUI entity CRUD completion); steerAgentRuntime restores the steer facet for
  // W3-T1 AgentSteering's mid-run instruction write
  // (dec_C0AF8CBBFFECF71F4F34FB76F9 CH2/CH4 — supersedes the 2026-10-14 no-consumer removal);
  // unpinEntity is the overview pinned region's entity-level unpin
  // (task_9ba495de: same entity-unpin write path as `ha unpin <ref>`).
  const editingFacets = [...daemonActionRoutes.map(({ method }) => method), "repo.vertical.declaration.read"];
  // S8 CH2: assignTask and unassignTask.
  // dec_DBF9CCB96B1A7D35A3214615E1 CH2/CH6: one dispatcher for export/claim/revoke.
  // dec_E369B8616F50A6208B293997E7/CH5 (W2-2) deletes the task.adjudicate facet with the command.
  // dec_5DBF5F2B38719E4B52003D178D/CH1: showTask + reworkTask share the canonical Task actions.
  // dec_9C43012EBB2754D7112F618F0D CH2/CH3 and dec_13B7B846B56BFA192533011B91 CH1:
  // three closed aliases for existing canonical actions; generic repo.task.run stays forbidden.
  // dec_4276A0CEACD4D402F122295925/CH1 (W3): repo.dossier.synthesize joins daemonActionRoutes
  // for the Living Dossier GUI tab's incremental refresh.
  // dec_166C5D2EAB57F8BCA3F15107E2/CH2,CH4 (task_b75af18a8ce517d88ee1cb2bd9): adds 6 channel/peer GUI facets
  // (repo.channel.list/deliver/send, repo.peer.inbox/reply/promote) (70 -> 76 / 69 -> 75).
  assert.equal(editingFacets.length, 76);
  assert.equal(preloadAllowlist.includes("repo.vertical.declaration.read"), true);
  assert.equal(preloadAllowlist.includes("repo.dossier.synthesize"), true);
  // entity.update / entity.archive / entity.delete plus vertical kind upsert / publish-schema / retire
  // are explicit GUI facets. Todo contributes eight GUI actions from the repository todo task.
  // Channel and peer workbench routes add six actions (69 -> 75 actions / 76 editing facets).
  assert.equal(daemonActionRoutes.length, 75);
  assert.equal(daemonActionRoutes.find(({ method }) => method === "repo.task.create")?.actionKind, "task-create");
  assert.equal(
    daemonActionRoutes.some(({ method }) => method === "repo.entity.delete"),
    true,
  );
  assert.equal(
    daemonActionRoutes.some(({ method }) => method === "repo.task.run"),
    false,
  );
  // pinTask/unpinTask 是台账 pin 的 GUI 写通道,但不是通用 amend:payload 只收
  // repoId+taskId,pinned-only patch 由 daemon 契约的 actionDefaults 钉死。
  for (const method of ["repo.task.pin", "repo.task.unpin"]) {
    assert.equal(assertPreloadPayload(method, { repoId: "repo-a", taskId: "task-a" }), true);
    assert.throws(() => assertPreloadPayload(method, { repoId: "repo-a" }), /invalid/u);
    assert.throws(() => assertPreloadPayload(method, { repoId: "repo-a", taskId: "task-a", patches: [] }), /invalid/u);
    assert.throws(() => assertPreloadPayload(method, { repoId: "repo-a", taskId: "" }), /invalid/u);
  }
  // unpinEntity 是置顶区非任务实体的解 pin 通道(task_9ba495de):payload 只收 repoId+
  // entityRef,与 `ha unpin <ref>` 同一条 entity-unpin 动作,ref 合法性由 daemon 写边界判。
  assert.equal(assertPreloadPayload("repo.entity.unpin", { repoId: "repo-a", entityRef: "decision/dec_1" }), true);
  assert.throws(() => assertPreloadPayload("repo.entity.unpin", { repoId: "repo-a", entityRef: "" }), /invalid/u);
  assert.throws(
    () =>
      assertPreloadPayload("repo.entity.unpin", { repoId: "repo-a", entityRef: "decision/dec_1", taskId: "task-a" }),
    /invalid/u,
  );
  assert.throws(() => assertPreloadPayload("repo.entity.unpin", { entityRef: "decision/dec_1" }), /repoId/u);
  // retireRelation 是答复 awaits 的 GUI 写通道(`ha relation unrelate` 同一动作):payload 闭集由
  // daemon RPC 形状把守,多余字段(如改写 rationale)在 RPC 校验层就被拒。
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.relation.unrelate",
      params: { repo: { repoId: "repo-a" }, payload: { relationId: "rel_a", reason: "通过", expectedVersion: 3 } },
    }),
    [],
  );
  assert.notDeepEqual(
    validateDaemonRpcCall({
      method: "repo.relation.unrelate",
      params: {
        repo: { repoId: "repo-a" },
        payload: { relationId: "rel_a", reason: "通过", expectedVersion: 3, rationale: "改写问题" },
      },
    }),
    [],
  );
  // dec_89D06D7360CBEC09795F7B12EC: 收口与同意沿用各自的动作契约。
  assert.throws(
    () => assertPreloadPayload("repo.task.complete", { repoId: "repo-a", taskId: "task-a", consent: true }),
    /unknown field "consent"/u,
  );
  assert.equal(assertPreloadPayload("repo.task.complete", { repoId: "repo-a", taskId: "task-a" }), true);
  // taskAttest 是 Gate 签注/特批的 GUI 写通道,与 `ha task attest` 同一个 task-attest 动作;
  // mode/rationale 与人类 principal 的准入只在 daemon handler 判定。
  assert.equal(preloadAllowlist.includes("repo.task.attest"), true);
  assert.equal(daemonActionRoutes.find(({ method }) => method === "repo.task.attest")?.actionKind, "task-attest");
  assert.equal(
    daemonActionRoutes.some(({ method }) => method === "repo.agentRuntime.cancel"),
    true,
  );
  assert.equal(
    daemonActionRoutes.some(({ method }) => method === "repo.agent.entity.write"),
    true,
  );
  assert.equal(
    daemonActionRoutes.some(({ method }) => method === "repo.squad.entity.write"),
    true,
  );
  assert.equal(preloadAllowlist.includes("daemon.agentRuntime.credentials.bind" as never), false);
  assert.equal(preloadAllowlist.includes("repo.task.start"), true);
  assert.equal(preloadAllowlist.includes("repo.receipt.show"), true);
  assert.equal(preloadAllowlist.includes("repo.settings.read"), true);
  assert.equal(preloadAllowlist.includes("repo.settings.update"), true);
});

test("dec_89D06D7360CBEC09795F7B12EC: repository scopes close both the envelope and its payload", () => {
  assert.deepEqual(scopedRpcParams("repo.settings.read", { repoId: "repo-a" }), { repo: { repoId: "repo-a" } });
  assert.throws(() => assertRendererRpc("repo.settings.read", { repo: { repoId: "repo-a" }, payload: {} }), /invalid/u);
  assert.throws(
    () =>
      assertRendererRpc("repo.task.run", { repo: { repoId: "repo-a" }, payload: { action: { kind: "task-archive" } } }),
    /not allowed/u,
  );
});

// Schedule actions (S4) take exactly the retry-stable claim trio; the schedule read is now the
// `schedule-plane` use-case projection, admitted at the preload by the very function the daemon
// request validator and repo-cell handler call, so extra fields never survive the boundary.
test("schedule read and action payloads stay closed at the preload boundary", () => {
  assert.equal(assertPreloadPayload("repo.projection.read", { repoId: "repo-a", name: "schedule-plane" }), true);
  assert.throws(
    () =>
      assertPreloadPayload("repo.projection.read", {
        repoId: "repo-a",
        name: "schedule-plane",
        scheduleId: "heartbeat-probe",
      }),
    /does not accept scheduleId/u,
  );
  // The run-history projection does take a scheduleId — the closure is per projection, not global.
  assert.equal(
    assertPreloadPayload("repo.projection.read", {
      repoId: "repo-a",
      name: "schedule-run-history",
      scheduleId: "heartbeat-probe",
    }),
    true,
  );
  assert.throws(
    () => assertPreloadPayload("repo.projection.read", { repoId: "repo-a", name: "repo.schedules.list" }),
    /name must be one of/u,
  );
  for (const method of ["repo.schedule.enable", "repo.schedule.disable", "repo.schedule.runNow"]) {
    assert.equal(
      assertPreloadPayload(method, { repoId: "repo-a", scheduleId: "heartbeat-probe", idempotencyKey: "retry-1" }),
      true,
    );
    assert.throws(() => assertPreloadPayload(method, { repoId: "repo-a", scheduleId: "heartbeat-probe" }), /invalid/u);
    assert.throws(
      () => assertPreloadPayload(method, { repoId: "repo-a", scheduleId: "heartbeat-probe", idempotencyKey: 7 }),
      /invalid/u,
    );
    assert.throws(
      () =>
        assertPreloadPayload(method, {
          repoId: "repo-a",
          scheduleId: "heartbeat-probe",
          idempotencyKey: "retry-1",
          observedDefinitionRevision: 3,
        }),
      /invalid/u,
    );
  }
  const definition = {
    repoId: "repo-a",
    scheduleId: "heartbeat-probe",
    name: "Heartbeat probe",
    mode: "detect",
    everyMs: 300_000,
    agentId: "probe-agent",
    mission: "Run the probe.",
    idempotencyKey: "retry-1",
  };
  for (const retired of [{ runtimeInstanceId: "retired" }, { model: "retired" }])
    for (const method of ["repo.schedule.create", "repo.schedule.update"])
      assert.throws(() => assertPreloadPayload(method, { ...definition, ...retired }), /invalid/u);
  const { everyMs: _everyMs, ...cronDefinition } = definition;
  assert.equal(assertPreloadPayload("repo.schedule.create", definition), true);
  assert.equal(assertPreloadPayload("repo.schedule.update", { ...definition, reasoningEffort: null }), true);
  // Cron payloads carry cronExpression + a non-empty timezone instead of everyMs.
  assert.equal(
    assertPreloadPayload("repo.schedule.create", { ...cronDefinition, cronExpression: "30 2 * * *", timezone: "UTC" }),
    true,
  );
  assert.equal(
    assertPreloadPayload("repo.schedule.update", {
      ...cronDefinition,
      cronExpression: "30 2 * * 1,3",
      timezone: "Asia/Shanghai",
      reasoningEffort: null,
    }),
    true,
  );
  // The trigger stays exactly-one: interval+cron together, or cron without a timezone, is refused.
  assert.throws(
    () =>
      assertPreloadPayload("repo.schedule.create", { ...definition, cronExpression: "30 2 * * *", timezone: "UTC" }),
    /invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("repo.schedule.create", { ...cronDefinition, cronExpression: "30 2 * * *" }),
    /invalid/u,
  );
  assert.throws(
    () =>
      assertPreloadPayload("repo.schedule.create", { ...cronDefinition, cronExpression: "30 2 * * *", timezone: " " }),
    /invalid/u,
  );
  // mode is required on create, optional on a partial update, and limited to the daemon
  // vocabulary wherever it appears.
  const { mode: _mode, ...withoutMode } = definition;
  assert.throws(() => assertPreloadPayload("repo.schedule.create", withoutMode), /invalid/u);
  assert.equal(assertPreloadPayload("repo.schedule.update", withoutMode), true);
  assert.throws(() => assertPreloadPayload("repo.schedule.update", { ...definition, mode: "observe" }), /invalid/u);
  // A built-in edit sends name, trigger, and retention parameters only — no agent target.
  assert.equal(
    assertPreloadPayload("repo.schedule.update", {
      repoId: "repo-a",
      scheduleId: "builtin-ledger-backup",
      name: "Ledger backup",
      cronExpression: "30 4 * * *",
      timezone: "UTC",
      keepDays: 5,
      keepMonthly: false,
      idempotencyKey: "retry-1",
    }),
    true,
  );
  // Retention parameters are update-only and bounded; create stays agent-shaped.
  assert.throws(() => assertPreloadPayload("repo.schedule.create", { ...definition, keepDays: 5 }), /invalid/u);
  assert.throws(() => assertPreloadPayload("repo.schedule.update", { ...definition, keepDays: 0 }), /invalid/u);
  assert.throws(() => assertPreloadPayload("repo.schedule.update", { ...definition, keepMonthly: "yes" }), /invalid/u);
  assert.equal(
    assertPreloadPayload("repo.schedule.delete", {
      repoId: "repo-a",
      scheduleId: "heartbeat-probe",
      reason: "retired",
      idempotencyKey: "retry-1",
    }),
    true,
  );
  assert.throws(() => assertPreloadPayload("repo.schedule.create", { ...definition, everyMs: 30_000 }), /invalid/u);
  assert.throws(
    () => assertPreloadPayload("repo.schedule.update", { ...definition, mission: "", extra: true }),
    /invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("repo.schedule.delete", { repoId: "repo-a", scheduleId: "heartbeat-probe" }),
    /invalid/u,
  );
});

// The Agent/Squad detail reads are contract-derived with their own input schema:
// they must stay payload-open (repoId + entity id) while true empty-schema reads
// stay closed to repoId only. Replayed against the real contract facets, not
// synthetic ones, so a derivation regression cannot hide behind a fixture.
test("Agent and Squad detail payload paths stay open on the real contract", () => {
  assert.equal(assertPreloadPayload("repo.agent.entity.read", { repoId: "repo-a", agentId: "fable" }), true);
  assert.equal(assertPreloadPayload("repo.squad.entity.read", { repoId: "repo-a", squadId: "core-squad" }), true);
  assert.equal(assertPreloadPayload("repo.agent.entities.list", { repoId: "repo-a" }), true);
  assert.equal(assertPreloadPayload("repo.squad.entities.list", { repoId: "repo-a" }), true);
  assert.throws(
    () => assertPreloadPayload("repo.agent.entities.list", { repoId: "repo-a", agentId: "fable" }),
    /invalid/u,
  );
});

test("Agent and Squad writes stay on the daemon allowlist and reject secret-shaped declaration keys", () => {
  const agent = {
    repoId: "repo-a",
    declaration: {
      schema: "agent-declaration/v1",
      id: "fable",
      name: "Fable",
      instructions: "Review.",
      runtimes: [],
    },
  };
  const squad = {
    repoId: "repo-a",
    declaration: {
      schema: "squad-declaration/v1",
      id: "blue-squad",
      name: "Blue",
      leader: "fable",
      workers: [],
      leaderTurnBudget: 8,
      roster: "# Blue\n",
    },
  };
  assert.equal(assertPreloadPayload("repo.agent.entity.write", agent), true);
  assert.equal(assertPreloadPayload("repo.squad.entity.write", squad), true);
  assert.throws(
    () =>
      assertPreloadPayload("repo.agent.entity.write", {
        ...agent,
        declaration: { ...agent.declaration, apiKey: "no" },
      }),
    /secret-like key/u,
  );
});

test("only newly typed top-level create/update API keys cross preload", () => {
  const create = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    instanceId: "codex-sidecar",
    name: "Codex sidecar",
    kindId: "codex",
    installationId: "codex-install",
    providerId: "codex_local_access",
    models: ["gpt-5.6-terra"],
    codex: { baseUrl: "http://localhost:50818/v1", wireApi: "responses", requiresOpenAiAuth: true },
    authMode: "api-key",
    apiKey: "sk-typed-by-user",
    ...overrides,
  });
  assert.equal(assertPreloadPayload("daemon.runtimeInstance.create", create()), true);
  assert.equal(assertPreloadPayload("daemon.runtimeInstance.create", create({ repoId: "server-a" })), true);
  assert.equal(
    assertPreloadPayload("daemon.runtimeInstance.update", {
      repoId: "server-b",
      instanceId: "codex-sidecar",
      apiKey: "new-key",
    }),
    true,
  );
  assert.equal(assertPreloadPayload("daemon.runtimeInstance.list", { repoId: "server-b", all: true }), true);
  assert.throws(
    () =>
      assertPreloadPayload("daemon.runtimeInstance.update", {
        repoId: "",
        instanceId: "codex-sidecar",
        apiKey: "new-key",
      }),
    /repoId/u,
  );
  assert.throws(
    () =>
      assertPreloadPayload("daemon.runtimeInstance.update", {
        instanceId: "codex-sidecar",
        nested: { apiKey: "nested" },
      }),
    /secret-like/u,
  );
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.create", create({ authMode: "subscription" })),
    /invalid/u,
  );
  assert.throws(() => assertPreloadPayload("daemon.runtimeInstance.create", create({ apiKey: "  " })), /invalid/u);
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.create", create({ codex: { apiKey: "nested-forbidden" } })),
    /secret-like key/u,
  );
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.show", { instanceId: "codex-sidecar", apiKey: "wrong-method" }),
    /secret-like key/u,
  );
  assert.throws(
    () => assertPreloadPayload("repo.agentRuntime.spawn", { repoId: "repo-a", nested: { apiKey: "wrong-path" } }),
    /secret-like key/u,
  );
});

test("preload accepts the renderer's codex create payload", () => {
  const payload = buildRuntimeInstanceCreatePayload(
    {
      ...runtimeCreateForm,
      instanceId: "codex-sidecar",
      name: "Codex sidecar",
      kindId: "codex",
      providerId: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      fast: true,
      permissionMode: "workspace-write",
      isolation: "enforced",
    },
    "codex-install",
  );
  assert.deepEqual(Object.keys(payload).sort(), [
    "authMode",
    "codex",
    "installationId",
    "instanceId",
    "isolationState",
    "kindId",
    "models",
    "name",
    "permissionMode",
    "providerId",
  ]);
  assert.equal(assertPreloadPayload("daemon.runtimeInstance.create", payload), true);
});

test("preload accepts the renderer's detected model default", () => {
  const payload = buildRuntimeInstanceCreatePayload(
    {
      ...runtimeCreateForm,
      instanceId: "codex-detected",
      name: "Codex detected",
      kindId: "codex",
      providerId: "openai",
      model: "",
      permissionMode: "workspace-write",
      isolation: "enforced",
    },
    "codex-install",
    { models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-sol" },
  );
  assert.equal(payload.defaultModel, "gpt-5.6-sol");
  assert.equal(assertPreloadPayload("daemon.runtimeInstance.create", payload), true);
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.create", { ...payload, defaultModel: "typed-by-hand" }),
    /defaultModel.*listed models/u,
  );
});

test("preload accepts the renderer's claude create payload", () => {
  const payload = buildRuntimeInstanceCreatePayload(runtimeCreateForm, "claude-install");
  assert.deepEqual(Object.keys(payload).sort(), [
    "authMode",
    "claude",
    "installationId",
    "instanceId",
    "isolationState",
    "kindId",
    "models",
    "name",
    "permissionMode",
    "providerId",
  ]);
  assert.equal(assertPreloadPayload("daemon.runtimeInstance.create", payload), true);
  // The claude plane's effort enum reaches the daemon through the same create payload.
  const withEffort = buildRuntimeInstanceCreatePayload(
    { ...runtimeCreateForm, reasoningEffort: "high" },
    "claude-install",
  );
  assert.deepEqual((withEffort as { readonly claude: Record<string, unknown> }).claude, { effort: "high" });
  assert.equal(assertPreloadPayload("daemon.runtimeInstance.create", withEffort), true);
});

test("preload accepts the renderer's agy create payload", () => {
  const payload = buildRuntimeInstanceCreatePayload(
    {
      ...runtimeCreateForm,
      instanceId: "agy-one",
      name: "agy one",
      kindId: "agy",
      providerId: "google",
      model: "gemini-3.1-pro-low",
      reasoningEffort: "medium",
      permissionMode: undefined,
    },
    "agy-install",
  );
  assert.deepEqual(Object.keys(payload).sort(), [
    "agy",
    "authMode",
    "installationId",
    "instanceId",
    "isolationState",
    "kindId",
    "models",
    "name",
    "providerId",
  ]);
  assert.equal(assertPreloadPayload("daemon.runtimeInstance.create", payload), true);
});

test("runtime create rejection names an unknown field and the allowed expectation", () => {
  const payload = buildRuntimeInstanceCreatePayload(runtimeCreateForm, "claude-install");
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.create", { ...payload, unexpectedField: true }),
    /unexpectedField.*expected only/u,
  );
});

test("runtime create rejection names invalid models and the expected shape", () => {
  const payload = buildRuntimeInstanceCreatePayload(runtimeCreateForm, "claude-install");
  // dec_DA1602487428A58E8B446ECE38/CH2 adds only the disabled independent bootstrap exception.
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.create", { ...payload, models: [] }),
    /models.*non-blank strings.*disabled independent subscription/u,
  );
});

test("runtime create rejection names invalid permission mode and its enum", () => {
  const payload = buildRuntimeInstanceCreatePayload(runtimeCreateForm, "claude-install");
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.create", { ...payload, permissionMode: "admin" }),
    /permissionMode.*bypass, workspace-write, or read-only/u,
  );
});

test("runtime create rejection names invalid isolation state and its enum", () => {
  const payload = buildRuntimeInstanceCreatePayload(runtimeCreateForm, "claude-install");
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.create", { ...payload, isolationState: "disabled" }),
    /isolationState.*enforced or operator-environment/u,
  );
});

// The update payload's field set is derived from the registry entry rather than hand-written.
// Before this, preload closed the payload over four hand-listed fields while the contract
// declared eight, so name/installationId/models/defaultModel were unreachable from the GUI
// even though the daemon accepted them.
test("runtime update accepts exactly the fields the registry declares", () => {
  const entry = interactiveRpcMethods.find((facet) => facet.method === "daemon.runtimeInstance.update") as {
    readonly params: { readonly fields: { readonly payload: { readonly fields: Readonly<Record<string, unknown>> } } };
  };
  const declared = Object.keys(entry.params.fields.payload.fields);
  assert.deepEqual([...declared].sort(), [
    "apiKey",
    "baseUrl",
    "clearFreeze",
    "credentialSource",
    "defaultModel",
    "effort",
    "enabled",
    "fast",
    "installationId",
    "instanceId",
    "isolationState",
    "mcpPolicy",
    "models",
    "name",
    "permissionMode",
    // dec_DA1602487428A58E8B446ECE38/CH3 adds the priority tier to runtime updates.
    "tier",
    "webSearch",
  ]);
  for (const field of declared.filter((name) => name !== "instanceId")) {
    const sample: Record<string, unknown> =
      field === "tier"
        ? { tier: 2 }
        : field === "models"
          ? { models: ["model-a"] }
          : field === "enabled" || field === "clearFreeze"
            ? { [field]: true }
            : field === "fast"
              ? { fast: true }
              : field === "permissionMode"
                ? { permissionMode: "bypass" }
                : field === "isolationState"
                  ? { isolationState: "enforced" }
                  : field === "credentialSource"
                    ? { credentialSource: "operator" }
                    : field === "mcpPolicy"
                      ? { mcpPolicy: "disabled" }
                      : field === "webSearch"
                        ? { webSearch: "disabled" }
                        : { [field]: "value" };
    assert.equal(
      assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", ...sample }),
      true,
      `registry declares ${field} but preload rejected it`,
    );
  }
});

test("runtime create and update validate credential source values", () => {
  const payload = buildRuntimeInstanceCreatePayload(runtimeCreateForm, "claude-install");
  assert.equal(
    assertPreloadPayload("daemon.runtimeInstance.create", { ...payload, credentialSource: "operator" }),
    true,
  );
  assert.equal(
    assertPreloadPayload("daemon.runtimeInstance.create", {
      ...payload,
      credentialSource: "instance",
      isolationState: "enforced",
    }),
    true,
  );
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.create", { ...payload, credentialSource: "shared" }),
    /credentialSource.*operator, instance/u,
  );
  assert.equal(
    assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", credentialSource: "instance" }),
    true,
  );
  assert.throws(
    () =>
      assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", credentialSource: "shared" }),
    /invalid/u,
  );
});

test("runtime update still rejects empty values, empty model lists, and secret-like keys", () => {
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", name: "" }),
    /invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", models: [] }),
    /invalid/u,
  );
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", models: [1] }),
    /invalid/u,
  );
  assert.throws(() => assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a" }), /invalid/u);
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", apiKey: "  " }),
    /invalid/u,
  );
  for (const webSearch of ["disabled", "cached", "live"])
    assert.equal(assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", webSearch }), true);
  assert.equal(
    assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", webSearch: "" }),
    true,
  );
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", webSearch: "live-ish" }),
    /invalid/u,
  );
  for (const mcpPolicy of ["disabled", "inherit", ""])
    assert.equal(assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", mcpPolicy }), true);
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", mcpPolicy: "all" }),
    /invalid/u,
  );
  const codexCreate = buildRuntimeInstanceCreatePayload(
    { ...runtimeCreateForm, kindId: "codex", providerId: "openai", isolation: "enforced", mcpPolicy: "inherit" },
    "codex-install",
  );
  assert.equal(codexCreate.mcpPolicy, "inherit");
  assert.equal(assertPreloadPayload("daemon.runtimeInstance.create", codexCreate), true);
  assert.throws(
    () =>
      assertPreloadPayload("daemon.runtimeInstance.create", {
        ...codexCreate,
        kindId: "agy",
        agy: {},
        codex: undefined,
        permissionMode: undefined,
      }),
    /mcpPolicy.*omitted/u,
  );
  // No usage payload crosses the preload boundary, so string-valued token keys stay rejected
  // under every spelling — the value-type line from the dispatch scrubber has no traffic here.
  for (const key of ["token", "access_token", "id_token"])
    assert.throws(
      () => assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", [key]: "opaque" }),
      /secret-like/u,
    );
});

test("Decisions Provider credentials cross preload only as a top-level API key", () => {
  assert.equal(
    assertPreloadPayload("daemon.provider.create", {
      type: "decisions",
      providerId: "decision-a",
      name: "Decision A",
      model: "openai/model-a",
      apiKey: "fixture-key",
      enabled: true,
    }),
    true,
  );
  assert.equal(
    assertPreloadPayload("daemon.provider.update", { providerId: "decision-a", name: "Updated", apiKey: "new-key" }),
    true,
  );
  assert.throws(
    () =>
      assertPreloadPayload("daemon.provider.create", {
        type: "llm",
        providerId: "decision-a",
        name: "A",
        model: "m",
        apiKey: "key",
      }),
    /Only Decisions API providers/u,
  );
  assert.throws(
    () =>
      assertPreloadPayload("daemon.provider.create", {
        type: "decisions",
        providerId: "decision-a",
        name: "Decision A",
        model: "openai/model-a",
        credential: { apiKey: "nested-key" },
      }),
    /secret-like/u,
  );
  assert.throws(
    () =>
      assertPreloadPayload("daemon.provider.create", {
        type: "decisions",
        providerId: "decision-a",
        name: "Decision A",
        model: "openai/model-a",
        unexpected: true,
      }),
    /unknown field "unexpected"/u,
  );
});

test("multi-account tier bounds and read-only account catalog are enforced at preload", () => {
  const payload = buildRuntimeInstanceCreatePayload(runtimeCreateForm, "claude-install");
  // dec_DA1602487428A58E8B446ECE38/CH2: bootstrap before choosing observed account models.
  const bootstrap = {
    ...payload,
    models: [],
    defaultModel: undefined,
    enabled: false,
    credentialSource: "instance",
    isolationState: "enforced",
  };
  assert.equal(assertPreloadPayload("daemon.runtimeInstance.create", bootstrap), true);
  for (const invalid of [
    { enabled: true },
    { enabled: "false" },
    { credentialSource: "operator" },
    { authMode: "api-key", apiKey: "test-key" },
    { defaultModel: "invented-model" },
  ])
    assert.throws(() => assertPreloadPayload("daemon.runtimeInstance.create", { ...bootstrap, ...invalid }));
  for (const tier of [1, 9]) {
    assert.equal(assertPreloadPayload("daemon.runtimeInstance.create", { ...payload, tier }), true);
    assert.equal(assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", tier }), true);
  }
  for (const tier of [0, 10, 1.5, "2", null]) {
    assert.throws(() => assertPreloadPayload("daemon.runtimeInstance.create", { ...payload, tier }), /tier/u);
    assert.throws(
      () => assertPreloadPayload("daemon.runtimeInstance.update", { instanceId: "instance-a", tier }),
      /invalid/u,
    );
  }
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.create", { ...payload, availableModels: ["other"] }),
    /availableModels/u,
  );
  assert.throws(
    () =>
      assertPreloadPayload("daemon.runtimeInstance.create", {
        ...payload,
        kindId: "cursor",
        claude: undefined,
        cursor: {},
        credentialSource: "instance",
        isolationState: "enforced",
      }),
    /credentialSource/u,
  );
  for (const selectionStrategy of ["sticky", "lru"]) {
    assert.equal(
      assertPreloadPayload("repo.agent.entity.write", {
        repoId: "demo",
        declaration: {
          schema: "agent-declaration/v1",
          id: "worker",
          name: "Worker",
          role: "worker",
          instructions: "Work",
          runtimes: [],
          selectionStrategy,
        },
        expectedVersion: 0,
      }),
      true,
    );
  }
});

test("account action payloads and selection strategies fail closed", () => {
  for (const method of ["repo.runtimeInstance.auth.login", "repo.runtimeInstance.auth.logout"]) {
    assert.equal(
      assertPreloadPayload(method, { repoId: "demo", instanceId: "agy-pro", idempotencyKey: "login-1" }),
      true,
    );
    assert.throws(() => assertPreloadPayload(method, { repoId: "demo", instanceId: "agy-pro" }), /invalid/u);
    assert.throws(
      () =>
        assertPreloadPayload(method, {
          repoId: "demo",
          instanceId: "agy-pro",
          idempotencyKey: "login-1",
          credentialSource: "instance",
        }),
      /invalid/u,
    );
  }
  assert.equal(assertPreloadPayload("daemon.runtimeInstance.show", { instanceId: "agy-pro", probe: true }), true);
  assert.throws(
    () => assertPreloadPayload("daemon.runtimeInstance.show", { instanceId: "agy-pro", probe: "yes" }),
    /invalid/u,
  );
  assert.throws(
    // The declaration write boundary owns strategy validation; preload only transports this authored facet.
    () =>
      parseAgentDeclarationV1({
        schema: "agent-declaration/v1",
        id: "worker",
        name: "Worker",
        role: "worker",
        instructions: "Work",
        runtimes: [],
        selectionStrategy: "round-robin",
      }),
    /selectionStrategy/u,
  );
});

// Explicit negative controls for the three Decision-authorized agenda aliases.
test("agenda write aliases retain closed preload payloads", () => {
  for (const [method, payload] of [
    ["repo.task.archive", { taskIds: ["task-a", "task-b"], reason: "Received" }],
    ["repo.agentRuntime.incidentDismiss", { dispatchId: "dispatch-a", reason: "Handled" }],
    ["repo.task.escalationResolve", { taskId: "task-a", dispatchId: "dispatch-a", answer: "Proceed" }],
  ] as const) {
    assert.equal(isAllowedPreloadApiMethod(method), true);
    assert.equal(assertPreloadPayload(method, { repoId: "repo-a", ...payload }), true);
    // Preload owns method/repository admission; the canonical RPC schema owns payload closure.
    const facet = interactiveRpcMethods.find((entry) => entry.method === method)!;
    assert.notDeepEqual(
      validateDaemonRpcCall({
        method: facet.method,
        params: { repo: { repoId: "repo-a" }, payload: { ...payload, principal: "spoof" } },
      }),
      [],
    );
    assert.throws(() => assertPreloadPayload(method, payload), /repoId/u);
  }
});

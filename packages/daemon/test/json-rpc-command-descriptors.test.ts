// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  actionForDaemonMethod,
  commandClassForAction,
  daemonProtocolCommands,
  parseDaemonRpcParams,
} from "../src/protocol/daemon-protocol.contract.ts";

test("protocol descriptors preserve topology metadata without authorizing actions", () => {
  const expected = {
    "migrate-import": "repo-write",
    "projection-rebuild": "repo-write",
    "task-create": "repo-write",
    "preset-list": "repo-read",
    "preset-inspect": "repo-read",
    "preset-check": "repo-read",
    "preset-validate": "repo-read",
    "preset-install": "repo-write",
    "preset-seed": "repo-write",
    "preset-audit": "repo-read",
    "preset-uninstall": "repo-write",
    "preset-upgrade": "repo-write",
    "script-run": "repo-write",
    "preset-run-start": "repo-write",
    "preset-run-status": "repo-read",
    "task-start": "repo-write",
    "task-progress-append": "repo-write",
    "task-artifact-add": "repo-write",
    "task-submit": "repo-write",
    "task-declare-executor": "repo-write",
    "task-review-execution": "arbiter",
    "task-review-consent": "repo-write",
    "task-code-doc-reconcile": "repo-write",
    "task-code-doc-repoint": "repo-write",
    "task-complete": "repo-write",
    "task-show": "repo-read",
    "receipt-show": "repo-read",
    "doc-status": "repo-read",
    "doc-dry-run": "repo-read",
    "doc-submit": "repo-write",
    "doc-materialize": "repo-write",
    "doc-show": "repo-read",
    "doc-retire": "repo-write",
    "fact-record": "repo-write",
    "fact-search": "repo-read",
    "fact-type-list": "repo-read",
    "fact-show": "repo-read",
    "decision-propose": "repo-write",
    "decision-validate": "repo-read",
    "decision-repin": "repo-write",
    "decision-transition": "repo-write",
    "decision-accept": "arbiter",
    "decision-reject": "arbiter",
    "decision-defer": "arbiter",
    "decision-retire": "repo-write",
    "decision-supersede": "repo-write",
    "decision-amend": "repo-write",
    "decision-claim-add": "repo-write",
    "decision-claim-fulfill": "repo-write",
    "relation-relate": "repo-write",
    "relation-reconfirm": "repo-write",
    "relation-unrelate": "repo-write",
    "decision-reckon": "repo-write",
    "decision-list": "repo-read",
    "decision-show": "repo-read",
    "distill-candidate": "repo-write",
    "distill-promote": "repo-write",
  } as const;
  assert.deepEqual(
    Object.fromEntries(Object.keys(expected).map((kind) => [kind, commandClassForAction(kind)])),
    expected,
  );
  for (const command of daemonProtocolCommands)
    if (command.commandClass === "repo-read") assert.notEqual(command.method, "repo.task.run", command.id);
  const legacyRead = { action: { kind: "task-show", taskId: "task-direct" } };
  assert.deepEqual(actionForDaemonMethod("repo.task.read", legacyRead), legacyRead.action);
  assert.throws(() => actionForDaemonMethod("repo.task.run", legacyRead), /closed method descriptor/u);
});

test("task-create and preset RPC descriptors enforce closed payloads and retire the open route", () => {
  const params = { repo: { repoId: "alpha" }, payload: { title: "Closed", presetId: "standard-task" } };
  assert.equal(parseDaemonRpcParams("repo.task.create", params).ok, true);
  assert.equal(
    parseDaemonRpcParams("repo.task.create", { ...params, payload: { ...params.payload, dryRun: true } }).ok,
    true,
  );
  assert.equal(
    parseDaemonRpcParams("repo.task.create", { ...params, payload: { ...params.payload, dryRun: "true" } }).ok,
    false,
  );
  assert.equal(
    parseDaemonRpcParams("repo.task.create", { ...params, payload: { ...params.payload, completionGateIds: [] } }).ok,
    false,
  );
  assert.deepEqual(actionForDaemonMethod("repo.task.create", params.payload), {
    kind: "task-create",
    ...params.payload,
  });
  assert.throws(
    () => actionForDaemonMethod("repo.task.run", { action: { kind: "task-create", title: "Open" } }),
    /closed method/u,
  );
  const fullPayload = {
    taskId: "task_full",
    title: "Full",
    idempotencyKey: "once",
    parentTaskId: "task_parent",
    workKind: "feat",
    riskTier: "high",
    urgency: "medium",
    moduleKey: "kernel",
    registerModule: { key: "kernel", title: "Kernel", prefix: "KER", scope: "packages/kernel/**" },
    surfaces: ["ha task create"],
    createMode: "admin",
  };
  assert.equal(parseDaemonRpcParams("repo.task.create", { repo: { repoId: "alpha" }, payload: fullPayload }).ok, true);
  const retiredBoolean = parseDaemonRpcParams("repo.task.create", {
    repo: { repoId: "alpha" },
    payload: { ...fullPayload, longRunning: true },
  });
  assert.equal(retiredBoolean.ok, false);
  if (!retiredBoolean.ok) {
    assert.equal(retiredBoolean.errors.length, 1);
    assert.match(
      retiredBoolean.errors[0]!,
      /params\.payload contains an unknown field "longRunning"; allowed fields:/u,
    );
    for (const field of ["taskId", "title", "taskClass", "idempotencyKey"])
      assert.match(retiredBoolean.errors[0]!, new RegExp(`"${field}"`, "u"));
  }
  assert.equal(
    parseDaemonRpcParams("repo.task.create", {
      repo: { repoId: "alpha" },
      payload: { ...fullPayload, taskClass: "long_running" },
    }).ok,
    true,
  );
});

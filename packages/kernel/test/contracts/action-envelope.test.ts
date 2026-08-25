// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { actionReplayKey, validateActionEnvelope } from "../../src/domain/action-envelope.ts";
import { validateWriteReceipt } from "../../src/domain/receipt-domain-registry.ts";
import { createWriteReceipt, explainEntityKind } from "../../src/index.ts";

const actor = { principal: { personId: "person-action" }, executor: { kind: "agent" as const, id: "sol" } };
const action = {
  actionId: "action-start-1",
  kind: "start",
  target: "execution/exe_action",
  actor,
  authorizationRef: "task.start@1",
  idempotencyKey: "start-once",
};

test("Action envelope is one closed kernel contract with a stable replay identity", () => {
  assert.deepEqual(validateActionEnvelope(action), []);
  assert.equal(actionReplayKey(action), actionReplayKey({ ...action, actionId: "action-retry-2" }));
  assert.notEqual(actionReplayKey(action), actionReplayKey({ ...action, idempotencyKey: "start-twice" }));
  assert.match(validateActionEnvelope({ ...action, method: "repo.task.run" }).join("\n"), /unexpected.*method/u);
  assert.match(validateActionEnvelope({ ...action, idempotencyKey: "" }).join("\n"), /idempotencyKey is required/u);
});

test("the five promoted Entity explanations expose status-aligned transition Actions", () => {
  const catalogs = Object.fromEntries(
    ["execution", "review", "agent", "runtime-session", "policy"].map((kind) => [kind, explainEntityKind(kind)]),
  );
  assert.deepEqual(catalogs.execution?.statusVocabulary, [
    { field: "state", words: ["active", "submitted", "accepted", "changes_requested", "abandoned"] },
  ]);
  assert.deepEqual(catalogs.execution?.transitions.available, ["start", "renew", "submit", "complete", "release"]);
  assert.deepEqual(catalogs.review?.statusVocabulary, [
    { field: "verdict", words: ["approved", "changes_requested", "dismissed"] },
  ]);
  assert.deepEqual(catalogs.review?.transitions.available, ["record"]);
  assert.deepEqual(catalogs.agent?.statusVocabulary, [{ field: "state", words: ["configured", "active", "retired"] }]);
  assert.deepEqual(catalogs.agent?.transitions.available, ["configure", "activate", "retire"]);
  assert.deepEqual(catalogs.policy?.statusVocabulary, [{ field: "state", words: ["draft", "active", "retired"] }]);
  assert.deepEqual(catalogs.policy?.transitions.available, ["draft", "activate", "retire"]);
  assert.deepEqual(catalogs["runtime-session"]?.transitions.available, [
    "runtime_session_started",
    "runtime_session_provider_bound",
    "runtime_session_task_bound",
    "runtime_session_liveness_changed",
    "runtime_session_cancelled",
    "runtime_session_exited",
    "runtime_session_outcome_observed",
  ]);
});

test("new receipts default to an unwired AuthorizationDecision and an empty triadic delta", () => {
  const receipt = createWriteReceipt({
    outcome: "applied",
    opId: "op-action",
    revision: 1,
    evidence: "event:op-action",
    visibility: "center",
    proof: {
      committedRevision: 1,
      appliedCut: 1,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: null,
    },
  });
  assert.equal(receipt.authorizationDecision, null);
  assert.deepEqual(receipt.delta, { fact: [], decision: [], task: [] });
  assert.deepEqual(validateWriteReceipt(receipt), []);

  const authorized = {
    ...receipt,
    authorizationDecision: {
      policyRef: "task.start@1",
      actor,
      subject: "task/task-action",
      bindingsUsed: [],
      outcome: "allowed" as const,
      reasonCodes: [],
      nextActions: [],
      evaluatedAtCut: "canonical:1",
    },
    delta: {
      fact: [{ ref: "fact/task-action/F-action", before: null, after: { statement: "observed" } }],
      decision: [],
      task: [{ ref: "task/task-action", before: { status: "planned" }, after: { status: "active" } }],
    },
  };
  assert.deepEqual(validateWriteReceipt(authorized), []);
  assert.match(
    validateWriteReceipt({
      ...authorized,
      authorizationDecision: { ...authorized.authorizationDecision, evaluatedAtCut: "" },
    }).join("\n"),
    /AuthorizationDecision/u,
  );
  assert.match(
    validateWriteReceipt({ ...authorized, delta: { ...authorized.delta, decision: undefined } }).join("\n"),
    /closed fact, decision, and task/u,
  );
});

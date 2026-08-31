// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { actionReplayKey, validateActionEnvelope } from "../../src/domain/action-envelope.ts";
import { explainEntityKind } from "../../src/domain/entity-kind-registry.ts";
import { validateWriteReceipt } from "../../src/domain/receipt-domain-registry.ts";
import { createWriteReceipt } from "../../src/index.ts";

const actor = { principal: { personId: "person-action" }, executor: { kind: "agent" as const, id: "sol" } };
const action = {
  version: { major: 1, minor: 0 },
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

test("promoted Entity catalogs distinguish executable Agent and RuntimeSession actions", () => {
  const catalogs = Object.fromEntries(
    ["execution", "review", "agent", "runtime-session", "policy"].map((kind) => [kind, explainEntityKind(kind)]),
  );
  const declared = (kind: string) => catalogs[kind]?.transitions.actions.map(({ id }) => id);
  assert.deepEqual(catalogs.execution?.statusVocabulary, [
    { field: "state", words: ["active", "submitted", "accepted", "changes_requested", "abandoned"] },
  ]);
  assert.deepEqual(catalogs.execution?.transitions.available, []);
  assert.deepEqual(declared("execution"), ["start", "renew", "submit", "complete", "release"]);
  assert.deepEqual(catalogs.review?.statusVocabulary, [
    { field: "verdict", words: ["approved", "changes_requested", "dismissed"] },
  ]);
  assert.deepEqual(catalogs.review?.transitions.available, []);
  assert.deepEqual(declared("review"), ["record"]);
  assert.deepEqual(catalogs.agent?.statusVocabulary, []);
  assert.equal(catalogs.agent?.transitions.catalogRef, "kernel/agent-action/v1");
  assert.deepEqual(catalogs.agent?.transitions.available, ["install"]);
  assert.deepEqual(declared("agent"), ["install"]);
  assert.deepEqual(catalogs.policy?.statusVocabulary, []);
  assert.deepEqual(catalogs.policy?.transitions.available, []);
  assert.deepEqual(declared("policy"), ["draft", "activate", "retire"]);
  assert.deepEqual(catalogs["runtime-session"]?.transitions.available, [
    "runtime_session_started",
    "runtime_session_provider_bound",
    "runtime_session_task_bound",
    "runtime_session_liveness_changed",
    "runtime_session_cancelled",
    "runtime_session_exited",
    "runtime_session_outcome_observed",
  ]);
  assert.deepEqual(declared("runtime-session"), [
    "runtime_session_started",
    "runtime_session_provider_bound",
    "runtime_session_task_bound",
    "runtime_session_liveness_changed",
    "runtime_session_cancelled",
    "runtime_session_exited",
    "runtime_session_outcome_observed",
  ]);
});

test("public receipts require the structured AuthorizationDecision", () => {
  const authorizationDecision = {
    policyRef: "default@5",
    actor,
    subject: "task/task-action" as const,
    bindingsUsed: [],
    outcome: "allowed" as const,
    reasonCodes: ["authorization_allowed"],
    nextActions: [],
    evaluatedAtCut: "canonical:1",
  };
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
    authorizationDecision,
  });
  assert.equal(receipt.authorizationDecision, authorizationDecision);
  assert.deepEqual(validateWriteReceipt(receipt), []);
  const { authorizationDecision: _missing, ...missing } = receipt;
  assert.match(validateWriteReceipt(missing).join("\n"), /AuthorizationDecision/u);
  assert.match(
    validateWriteReceipt({
      ...receipt,
      authorizationDecision: { ...receipt.authorizationDecision, evaluatedAtCut: "" },
    }).join("\n"),
    /AuthorizationDecision/u,
  );
});

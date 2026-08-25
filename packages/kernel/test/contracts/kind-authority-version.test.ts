// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import factEventJsonSchema from "../../schemas/json/fact-event.schema.json" with { type: "json" };
import { agentRuntimeEventTypes } from "../../src/domain/agent-runtime.ts";
import { contractVersion } from "../../src/domain/contract-version.ts";
import { decisionEventTypes } from "../../src/domain/decision-event-types.ts";
import { entityKindContracts } from "../../src/domain/entity-kind-registry.ts";
import { TASK_LIFECYCLE_TRANSITIONS } from "../../src/domain/task-lifecycle-transitions.ts";
import {
  explainEntityKind,
  isContractVersionCompatible,
  requireEntityStoreKindContract,
} from "../../src/domain/index.ts";
import { entityRegistry } from "../../src/entity/registry.ts";

const expectedKinds = [
  "agent",
  "decision",
  "execution",
  "fact",
  "policy",
  "review",
  "runtime-session",
  "squad",
  "task",
] as const;

test("one named kind-contract authority explains all nine entity kinds with one shape", () => {
  assert.deepEqual(entityKindContracts.map(({ kind }) => kind).sort(), [...expectedKinds]);
  const explanations = expectedKinds.map(explainEntityKind);
  const shape = Object.keys(explanations[0]!).sort();
  for (const explanation of explanations) assert.deepEqual(Object.keys(explanation).sort(), shape, explanation.kind);
  assert.deepEqual(explanations.find(({ kind }) => kind === "task")?.sdkExposure, {
    sdk: { target: "TaskCapability", schemaId: "task-frontmatter" },
    agentCapability: { target: "task", schemaId: "task-frontmatter" },
  });
  assert.deepEqual(explanations.find(({ kind }) => kind === "fact")?.sdkExposure.sdk?.target, "FactCapability");
  assert.deepEqual(explanations.find(({ kind }) => kind === "decision")?.sdkExposure.sdk?.target, "DecisionCapability");
});

test("every Action declares version, target, SDK exposure, intent, transition, and coordination metadata", () => {
  const actions = entityKindContracts.flatMap(({ actionCatalog }) => actionCatalog?.actions ?? []);
  assert.ok(actions.length > 0);
  for (const action of actions) {
    assert.deepEqual(action.version, { major: 1, minor: 0 }, action.id);
    assert.match(action.target.refTemplate, new RegExp(`^${action.target.kind}/`, "u"), action.id);
    assert.deepEqual(Object.keys(action.sdkExposure).sort(), ["agentCapability", "sdk"], action.id);
    assert.equal(typeof action.intentId, "string", action.id);
    assert.ok(action.intentId.length > 0, action.id);
    assert.equal(typeof action.transitionId, "string", action.id);
    assert.ok(action.transitionId.length > 0, action.id);
    assert.deepEqual(
      Object.keys(action.coordination).sort(),
      ["dryRun", "fifo", "fleetProvisionalReservation", "wipAdmission"],
      action.id,
    );
  }
});

test("task Action semantics are projected directly from the lifecycle transition authority", () => {
  const taskActions = entityKindContracts.find(({ kind }) => kind === "task")?.actionCatalog?.actions ?? [];
  assert.equal(taskActions.length, TASK_LIFECYCLE_TRANSITIONS.length);
  for (const transition of TASK_LIFECYCLE_TRANSITIONS) {
    const action = taskActions.find(({ transitionId }) => transitionId === transition.id);
    assert.ok(action, transition.id);
    assert.equal(action.id, transition.id);
    assert.equal(action.intentId, transition.commandType);
    assert.deepEqual(action.coordination, transition.coordination);
  }
  assert.deepEqual(taskActions.find(({ transitionId }) => transitionId === "start_execution")?.coordination, {
    dryRun: "supported",
    wipAdmission: { nextStatus: "active" },
    fleetProvisionalReservation: "required",
    fifo: "required",
  });
  assert.deepEqual(taskActions.find(({ transitionId }) => transitionId === "block_task")?.coordination, {
    dryRun: "disabled",
    wipAdmission: { nextStatus: "blocked" },
    fleetProvisionalReservation: "disabled",
    fifo: "disabled",
  });
});

test("event-backed Action semantics are projected from their event vocabularies", () => {
  const eventAuthorities = [
    ["fact", [factEventJsonSchema.properties.type.const]],
    ["decision", decisionEventTypes],
    ["runtime-session", agentRuntimeEventTypes.filter((eventType) => eventType.startsWith("runtime_session_"))],
  ] as const;
  for (const [kind, eventTypes] of eventAuthorities) {
    const actions = entityKindContracts.find((contract) => contract.kind === kind)?.actionCatalog?.actions ?? [];
    assert.deepEqual(
      actions.map(({ id }) => id),
      eventTypes,
      kind,
    );
    for (const action of actions) {
      assert.equal(action.intentId, action.id, action.id);
      assert.equal(action.transitionId, action.id, action.id);
    }
  }
});

test("id-backed Action semantics reuse their catalog authority without aliases", () => {
  for (const kind of ["agent", "policy", "execution", "review"] as const) {
    const actions = entityKindContracts.find((contract) => contract.kind === kind)?.actionCatalog?.actions ?? [];
    assert.ok(actions.length > 0, kind);
    for (const action of actions) {
      assert.equal(action.intentId, action.id, action.id);
      assert.equal(action.transitionId, action.id, action.id);
    }
  }
});

test("framework registry is derived while dedicated kinds cannot enter generic entity writes", () => {
  for (const kind of ["task", "fact", "decision"] as const) {
    const framework = entityKindContracts.find((contract) => contract.kind === kind)?.framework;
    assert.ok(framework);
    assert.deepEqual(entityRegistry[kind].anchors, framework.anchors);
    assert.deepEqual(entityRegistry[kind].dispositionMatrix, framework.dispositionMatrix);
    assert.equal(entityRegistry[kind].storageForm, framework.storageForm);
    assert.throws(() => requireEntityStoreKindContract(kind), /authored through/u);
  }
  assert.equal(requireEntityStoreKindContract("agent").kind, "agent");
});

test("Action, projection, and protocol consumers share structured compatibility semantics", () => {
  const supported = contractVersion(3, 2);
  assert.equal(isContractVersionCompatible({ major: 3, minor: 0 }, supported), true);
  assert.equal(isContractVersionCompatible({ major: 3, minor: 2 }, supported), true);
  assert.equal(isContractVersionCompatible({ major: 3, minor: 3 }, supported), false);
  assert.equal(isContractVersionCompatible({ major: 2, minor: 9 }, supported), false);
  assert.equal(isContractVersionCompatible("entity-projection/d4-v3", supported), false);
});

// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { contractVersion } from "../../src/domain/contract-version.ts";
import { entityKindContracts } from "../../src/domain/entity-kind-registry.ts";
import { entityKindRefAuthorities } from "../../src/domain/entity-ref.ts";
import {
  explainEntityKind,
  getEntityKindContract,
  isContractVersionCompatible,
  requireEntityStoreKindContract,
} from "../../src/domain/index.ts";
import { entityFieldContracts } from "../../src/entity/field-contracts.ts";
import { entityRegistry, entityRegistryKinds } from "../../src/entity/registry.ts";
import { schemaRegistry } from "../../src/schemas/registry.ts";

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
const expectedResidency = {
  agent: { authored: "ledger" },
  decision: { authored: "ledger" },
  execution: { authored: "ledger", live: "runtime-local" },
  fact: { authored: "ledger" },
  policy: { authored: "ledger" },
  review: { authored: "ledger" },
  "runtime-session": { authored: "ledger", live: "runtime-local" },
  squad: { authored: "ledger" },
  task: { authored: "ledger" },
} as const;

test("one named kind-contract authority explains all nine entity kinds with one shape", () => {
  assert.deepEqual(entityKindContracts.map(({ kind }) => kind).sort(), [...expectedKinds]);
  for (const contract of entityKindContracts)
    assert.deepEqual(contract.residency, expectedResidency[contract.kind], `${contract.kind} residency`);
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

test("every Action declares version, target, and SDK exposure metadata", () => {
  const actions = entityKindContracts.flatMap(({ actionCatalog }) => actionCatalog?.actions ?? []);
  assert.ok(actions.length > 0);
  for (const action of actions) {
    const authority = entityKindContracts.find(({ kind }) => kind === action.target.kind);
    assert.ok(authority);
    assert.deepEqual(action.version, { major: 1, minor: 0 }, action.id);
    assert.equal(action.target.refTemplate, authority.id.refTemplate, action.id);
    assert.deepEqual(Object.keys(action.sdkExposure).sort(), ["agentCapability", "sdk"], action.id);
  }
});

test("kind identity views are derived from the ref grammar authority without leaking parser metadata", () => {
  for (const authority of entityKindRefAuthorities) {
    const contract = getEntityKindContract(authority.kind);
    assert.ok(contract);
    assert.deepEqual(contract.id, {
      field: authority.field,
      pattern: authority.pattern,
      refTemplate: authority.refTemplate,
    });
  }
});

test("framework registry derives schema and mutability while relation/session stay explicit boundaries", () => {
  for (const kind of ["task", "fact", "decision"] as const) {
    const contract = entityKindContracts.find((candidate) => candidate.kind === kind),
      framework = contract?.framework,
      schema = schemaRegistry.find(({ id }) => id === framework?.schemaId)?.schema;
    assert.ok(framework);
    assert.equal(entityRegistry[kind].schema, schema);
    assert.equal(entityRegistry[kind].mutabilityContract, entityFieldContracts[kind]);
    assert.deepEqual(entityRegistry[kind].anchors, framework.anchors);
    assert.deepEqual(entityRegistry[kind].dispositionMatrix, framework.dispositionMatrix);
    assert.equal(entityRegistry[kind].storageForm, framework.storageForm);
    assert.throws(() => requireEntityStoreKindContract(kind), /no generic entity-store surface/u);
  }
  assert.deepEqual([...entityRegistryKinds].sort(), ["decision", "fact", "relation", "session", "task"]);
  assert.equal(getEntityKindContract("relation"), undefined);
  assert.equal(getEntityKindContract("session"), undefined);
  assert.equal(requireEntityStoreKindContract("agent").kind, "agent");
  assert.equal(requireEntityStoreKindContract("squad").kind, "squad");
  for (const kind of ["execution", "review", "runtime-session", "policy"])
    assert.throws(() => requireEntityStoreKindContract(kind), /no generic entity-store surface/u);
  assert.equal(explainEntityKind("policy").authoring, null);
});

test("Action, projection, and protocol consumers share structured compatibility semantics", () => {
  const supported = contractVersion(3, 2);
  assert.equal(isContractVersionCompatible({ major: 3, minor: 0 }, supported), true);
  assert.equal(isContractVersionCompatible({ major: 3, minor: 2 }, supported), true);
  assert.equal(isContractVersionCompatible({ major: 3, minor: 3 }, supported), false);
  assert.equal(isContractVersionCompatible({ major: 2, minor: 9 }, supported), false);
  assert.equal(isContractVersionCompatible("entity-projection/d4-v3", supported), false);
});

// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { contractVersion } from "../../src/domain/contract-version.ts";
import { entityKindContracts } from "../../src/domain/entity-kind-registry.ts";
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

test("contract version authority remains import-free", async () => {
  const source = await readFile(new URL("../../src/domain/contract-version.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:^\s*import\s|(?:\bimport|\brequire)\s*\()/mu);
});

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

test("every Action declares version, target, and SDK exposure metadata", () => {
  const actions = entityKindContracts.flatMap(({ actionCatalog }) => actionCatalog?.actions ?? []);
  assert.ok(actions.length > 0);
  for (const action of actions) {
    assert.deepEqual(action.version, { major: 1, minor: 0 }, action.id);
    assert.match(action.target.refTemplate, new RegExp(`^${action.target.kind}/`, "u"), action.id);
    assert.deepEqual(Object.keys(action.sdkExposure).sort(), ["agentCapability", "sdk"], action.id);
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

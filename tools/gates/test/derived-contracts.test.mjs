// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertPhaseAppendOnly, discoverContractFiles, loadContracts, validateDerivedContracts } from "../derived-contracts.mjs";
import { makeRepo } from "./helpers.mjs";

function fixtureRepo(contract, workflow) {
  return makeRepo({
    "tools/gates/contracts/example.contract.mjs": `export default ${JSON.stringify(contract)};\n`,
    ".github/workflows/rebuild-gates.yml": workflow
  });
}

test("G11 discovers mjs and ts contract declarations", () => {
  const { rootDir } = fixtureRepo({ id: "one", phases: ["P2"], commands: [], gates: [], guards: [] }, "jobs:\n");
  const tsPath = path.join(rootDir, "packages/example/src/extra.contract.ts");
  mkdirSync(path.dirname(tsPath), { recursive: true });
  writeFileSync(tsPath, "export default { id: 'two', phases: ['P2'], commands: [], gates: [], guards: [] };\n");
  assert.deepEqual(discoverContractFiles(rootDir), [
    "packages/example/src/extra.contract.ts",
    "tools/gates/contracts/example.contract.mjs"
  ]);
});

test("G11 validates workflow projections from the authoritative contract", async () => {
  const declaration = {
    id: "one",
    phases: ["P2"],
    projection: { workflow: ".github/workflows/rebuild-gates.yml" },
    commands: [],
    guards: [],
    gates: [{ id: "G11", phase: "P2", job: "derived", command: "node gate.mjs --check" }]
  };
  const { rootDir } = fixtureRepo(declaration, "jobs:\n  derived:\n    steps:\n      - run: node gate.mjs --check\n");
  const loaded = await loadContracts(rootDir);
  assert.deepEqual(validateDerivedContracts(rootDir, loaded), []);

  const workflow = path.join(rootDir, ".github/workflows/rebuild-gates.yml");
  writeFileSync(workflow, "jobs:\n  manual-copy:\n    steps:\n      - run: node other.mjs\n");
  assert.match(validateDerivedContracts(rootDir, loaded).join("\n"), /workflow job is not declared|declared gate job is missing/u);
});

test("G11 rejects duplicate registry entries and non-append phase histories", () => {
  const contracts = [{
    file: "one.contract.mjs",
    declaration: {
      id: "one",
      phases: ["P2"],
      commands: [{ id: "same", phase: "P2" }, { id: "same", phase: "P2" }],
      gates: [],
      guards: []
    }
  }];
  assert.match(validateDerivedContracts("/not-a-repo", contracts).join("\n"), /duplicate commands id same/u);
  assert.deepEqual(assertPhaseAppendOnly(["P2"], ["P2", "P3"]), []);
  assert.match(assertPhaseAppendOnly(["P2", "P3"], ["P3"])[0], /append-only/u);
});

test("G11 accepts distinct schema ids and rejects a duplicate across contracts", () => {
  const contract = (file, id, schemaId) => ({ file, declaration: { id, phases: ["P2"], commands: [], gates: [], guards: [], schemas: [{ id: schemaId }] } });
  const distinct = [contract("one.contract.mjs", "one", "example/one"), contract("two.contract.mjs", "two", "example/two")];
  assert.deepEqual(validateDerivedContracts("/not-a-repo", distinct), []);
  assert.match(validateDerivedContracts("/not-a-repo", [...distinct, contract("three.contract.mjs", "three", "example/one")]).join("\n"), /duplicate schemas id example\/one; first declared in one\.contract\.mjs/u);
});

test("G11 requires an exact command, gate, guard, schema, and phase catalog projection", () => {
  const declaration = {
    id: "one",
    phases: ["P2"],
    projection: { catalog: "tools/gates/contracts/catalog.json" },
    commands: [{ id: "run", phase: "P2" }],
    gates: [{ id: "G11", phase: "P2" }],
    guards: [{ id: "safe", phase: "P2" }],
    schemas: [{ id: "example/v1" }]
  };
  const { rootDir } = fixtureRepo(declaration, "jobs:\n");
  const catalog = path.join(rootDir, "tools/gates/contracts/catalog.json");
  writeFileSync(catalog, JSON.stringify({
    contractId: "one",
    commands: ["run"],
    gates: ["G11"],
    guards: ["safe"],
    schemas: ["example/v1"],
    phases: ["P2"]
  }));
  assert.deepEqual(validateDerivedContracts(rootDir, [{ file: "example.contract.mjs", declaration }]), []);
  writeFileSync(catalog, JSON.stringify({ contractId: "one", commands: ["run"], gates: ["G11"], guards: ["safe"], schemas: ["manual-copy/v1"], phases: ["P2"] }));
  assert.match(validateDerivedContracts(rootDir, [{ file: "example.contract.mjs", declaration }]).join("\n"), /catalog projection differs/u);
});

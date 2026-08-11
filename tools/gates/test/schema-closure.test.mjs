// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { findLegacyReaders, validateSchemaClosure } from "../schema-closure.mjs";
import { makeRepo } from "./helpers.mjs";

function contract(schema) {
  return [{
    file: "tools/gates/contracts/example.contract.mjs",
    declaration: { id: "example", phases: ["P2"], commands: [], gates: [], guards: [], schemas: [schema] }
  }];
}

test("G23 requires schema, parser, writer, error, and rejecting fixture facets", async () => {
  const { rootDir } = makeRepo({
    "tools/gates/example.mjs": [
      "export const schema = {};",
      "export const parse = (value) => value.valid ? [] : ['invalid'];",
      "export const write = (value) => value;",
      "export class ContractError extends Error {}"
    ].join("\n"),
    "tools/gates/test/fixtures/invalid.json": "{\"valid\":false}\n"
  });
  const complete = {
    id: "example",
    schema: "tools/gates/example.mjs#schema",
    parser: "tools/gates/example.mjs#parse",
    writer: "tools/gates/example.mjs#write",
    error: "tools/gates/example.mjs#ContractError",
    negativeFixtures: ["tools/gates/test/fixtures/invalid.json"]
  };
  assert.deepEqual(await validateSchemaClosure(rootDir, contract(complete)), []);
  assert.match((await validateSchemaClosure(rootDir, contract({ ...complete, writer: undefined }))).join("\n"), /writer must use path#export/u);
  assert.match((await validateSchemaClosure(rootDir, contract({ ...complete, negativeFixtures: [] }))).join("\n"), /negative fixture is required/u);
});

test("G24 rejects accepted negative fixtures and legacy reader markers", async () => {
  const { rootDir } = makeRepo({
    "tools/gates/example.mjs": "export const schema = {}; export const parse = () => []; export const write = x => x; export class ContractError extends Error {}\n",
    "tools/gates/test/fixtures/invalid.json": "{}\n"
  });
  const schema = {
    id: "example",
    schema: "tools/gates/example.mjs#schema",
    parser: "tools/gates/example.mjs#parse",
    writer: "tools/gates/example.mjs#write",
    error: "tools/gates/example.mjs#ContractError",
    negativeFixtures: ["tools/gates/test/fixtures/invalid.json"]
  };
  assert.match((await validateSchemaClosure(rootDir, contract(schema))).join("\n"), /negative fixture was accepted/u);

  const legacyPath = path.join(rootDir, "packages/example/src/reader.ts");
  mkdirSync(path.dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, `// ${"@legacy"}-reader\n`);
  assert.deepEqual(findLegacyReaders(rootDir), ["packages/example/src/reader.ts"]);
});

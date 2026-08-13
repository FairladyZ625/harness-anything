// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import rule from "../eslint-rules/no-manual-contract-projection.js";

function lint(source, filename = "packages/example/src/index.ts") {
  const linter = new Linter({ configType: "flat" });
  return linter.verify(source, {
    files: ["**/*.ts"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", parserOptions: { ecmaFeatures: {} } },
    plugins: { ha: { rules: { "no-manual-contract-projection": rule } } },
    rules: { "ha/no-manual-contract-projection": "error" }
  }, { filename });
}

test("G12 permits contract declarations and SoT-derived projections", () => {
  assert.deepEqual(lint("export const gateRegistry = [{ id: 'G1' }];", "tools/gates/contracts/gates.contract.ts"), []);
  assert.deepEqual(lint("export const commandRegistry = commandSpecs.map(projectCommand);"), []);
});
test("G12 rejects manual registries and registration calls outside contracts", () => {
  assert.match(lint("const gateRegistry = [{ id: 'G1' }];")[0].message, /Do not handwrite gateRegistry/u);
  assert.match(lint("registry.registerCommand({ id: 'run' });")[0].message, /Register Command/u);
  assert.match(lint("const aliases = [{ usage: 'ha run', summary: 'Run' }];")[0].message, /Do not handwrite aliases/u);
  assert.match(lint("const aliases = [{ method: 'repo.run', requiresRepo: true }];")[0].message, /Do not handwrite aliases/u);
  assert.match(lint('const flags = new Set(["--manual"]);')[0].message, /Do not handwrite a CLI flag directory/u);
  assert.match(lint('const flags = new Set(write ? ["--one"] : ["--many"]);')[0].message, /Do not handwrite a CLI flag directory/u);
});

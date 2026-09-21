// harness-test-tier: contract
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkCatalogSchema } from "./check-catalog-schema.mjs";

test("catalog schema gate validates the replacement thin command directory", () => {
  for (const specifier of [
    "../../daemon/src/protocol/daemon-protocol.contract.ts",
    "@harness-anything/daemon/internal/protocol/daemon-protocol.contract",
  ]) {
    assert.deepEqual(
      checkCatalogSchema({
        legacyCatalog: path.join(tmpdir(), "missing-template-catalog"),
        minimumCommands: 1,
        entries: [{ usage: "ha task show <id>", summary: "Show a task." }],
        parserSource: `import { resolveThinCliCommand, thinCliCommands } from "${specifier}";`,
      }),
      { ok: true, failures: [] },
    );
  }
});
test("catalog schema gate rejects incomplete protocol directory imports in both path forms", () => {
  for (const specifier of [
    "../../daemon/src/protocol/daemon-protocol.contract.ts",
    "@harness-anything/daemon/internal/protocol/daemon-protocol.contract",
  ]) {
    const result = checkCatalogSchema({
      legacyCatalog: path.join(tmpdir(), "missing-template-catalog"),
      minimumCommands: 1,
      entries: [{ usage: "ha task show <id>", summary: "Show a task." }],
      parserSource: `import { resolveThinCliCommand } from "${specifier}";`,
    });
    assert.equal(result.ok, false);
    assert.match(result.failures.join("\n"), /must consume the daemon protocol/u);
  }
});
test("catalog schema gate rejects malformed or vacuous command entries", () => {
  const result = checkCatalogSchema({
    legacyCatalog: path.join(tmpdir(), "missing-template-catalog"),
    minimumCommands: 2,
    entries: [{ usage: "task show <id>", summary: "" }],
    parserSource: `const thinCliCommands = [];`,
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /contains 1 entries/u);
  assert.match(result.failures.join("\n"), /usage must start with ha/u);
  assert.match(result.failures.join("\n"), /summary must be non-empty/u);
  assert.match(result.failures.join("\n"), /must consume the daemon protocol/u);
  assert.match(result.failures.join("\n"), /must not restore a local command directory/u);
});

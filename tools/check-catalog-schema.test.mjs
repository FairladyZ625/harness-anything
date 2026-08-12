// harness-test-tier: contract
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkCatalogSchema } from "./check-catalog-schema.mjs";

test("catalog schema gate validates the replacement thin command directory", () => {
  assert.deepEqual(checkCatalogSchema({ legacyCatalog: path.join(tmpdir(), "missing-template-catalog"), minimumCommands: 1,
    commandSource: `[{ usage: "ha task show <id>", summary: "Show a task." }]`,
    parserSource: `import { resolveThinCliCommand, thinCliCommands } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";` }), { ok: true, failures: [] });
});
test("catalog schema gate rejects malformed or vacuous command entries", () => {
  const result = checkCatalogSchema({ legacyCatalog: path.join(tmpdir(), "missing-template-catalog"), minimumCommands: 2,
    commandSource: `[{ usage: "task show <id>", summary: "" }]`, parserSource: `const thinCliCommands = [];` });
  assert.equal(result.ok, false); assert.match(result.failures.join("\n"), /contains 1 entries/u); assert.match(result.failures.join("\n"), /usage must start with ha/u); assert.match(result.failures.join("\n"), /summary must be non-empty/u);
  assert.match(result.failures.join("\n"), /must consume the daemon protocol/u); assert.match(result.failures.join("\n"), /must not restore a local command directory/u);
});

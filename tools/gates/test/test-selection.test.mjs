// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { selectTests } from "../test-selection.mjs";

test("G25 maps module-policy production changes to every required tier", () => {
  const result = selectTests(["packages/cli/src/index.ts"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.required, ["fast", "contract", "integration"]);
  assert.deepEqual(result.paths[0], {
    path: "packages/cli/src/index.ts",
    module: "cli",
    kind: "production",
    tiers: ["fast", "contract", "integration"],
  });
});

test("G26 selects the changed test tier and governance mechanism tiers", () => {
  assert.deepEqual(selectTests(["packages/daemon/test/transport.integration.test.ts"]).required, ["integration"]);
  assert.deepEqual(
    selectTests(["packages/daemon/test/custom-name.test.ts"], { readTestTier: () => "contract" }).required,
    ["contract"],
  );
  const governance = selectTests(["tools/gates/evidence-contract.mjs", "tools/gates/test/evidence-contract.test.mjs"]);
  assert.deepEqual(governance.required, ["fast", "contract"]);
  assert.equal(governance.ok, true);
  assert.deepEqual(governance.paths[0], {
    path: "tools/gates/evidence-contract.mjs",
    module: "tooling",
    kind: "production",
    tiers: ["fast", "contract"],
  });
  assert.match(
    selectTests(["tools/gates/evidence-contract.mjs"]).errors.join("\n"),
    /require a tools\/gates\/test data fixture/u,
  );
});

test("G25 does not inherit the tooling production label outside its governance predicate", () => {
  const result = selectTests(["tools/check-pr-title.mjs"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.required, []);
  assert.match(result.proof.join("\n"), /outside G25 \(tooling\/production\)/u);
});

test("G25 zero selection is green only with complete non-production proof", () => {
  const result = selectTests(["docs/rebuild.md", ".github/ISSUE_TEMPLATE/bug.yml"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.required, []);
  assert.equal(result.proof.length, 2);

  const invalid = selectTests(["../outside.ts"]);
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("\n"), /not normalized.*lacks proof/su);
});

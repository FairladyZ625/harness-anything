// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { checkFleetTransferBoundary, findFleetTransferBypasses } from "../fleet-transfer-boundary.mjs";

test("Fleet production paths use the unified transfer boundary", () => {
  assert.deepEqual(checkFleetTransferBoundary(process.cwd()), []);
});

test("the negative direct large reply fixture is rejected", () => {
  const violations = findFleetTransferBypasses(
    'socket.write(JSON.stringify({ schema: "fleet.operational.read.result/v1", result: payload }) + "\\n");',
    "negative-fixture.ts",
  );
  assert.deepEqual(violations, [{ file: "negative-fixture.ts", line: 1, reason: "direct JSON socket write" }]);
});

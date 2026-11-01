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

test("the gate catches a direct JSON write split over source lines", () => {
  const violations = findFleetTransferBypasses(
    `socket
  .write(
    JSON
      .stringify(payload),
  );`,
    "multiline-negative-fixture.ts",
  );
  assert.deepEqual(violations, [
    { file: "multiline-negative-fixture.ts", line: 1, reason: "direct JSON socket write" },
  ]);
});

test("the gate catches a JSON reply assigned before the socket write", () => {
  const violations = findFleetTransferBypasses(
    `const reply = JSON.stringify(payload);\nconst line = reply;\nsocket.write(line + "\\n");`,
    "assigned-negative-fixture.ts",
  );
  assert.deepEqual(violations, [
    { file: "assigned-negative-fixture.ts", line: 3, reason: "JSON payload reaches socket.write through a variable" },
  ]);
});

test("the gate scans newly added Fleet source files", () => {
  const violations = findFleetTransferBypasses(
    'socket.write(JSON.stringify({ schema: "fleet.operational.read.result/v1", result: payload }));',
    "packages/daemon/src/fleet/new-rpc.ts",
  );
  assert.equal(violations[0]?.reason, "direct JSON socket write");
});

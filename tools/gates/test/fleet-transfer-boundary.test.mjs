// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

test("the full checker scans a real nested Fleet source path", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-transfer-boundary-"));
  try {
    const fixture = readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures/fleet-transfer-bypasses/nested/new-rpc.ts"),
      "utf8",
    );
    const nested = path.join(root, "packages/daemon/src/fleet/new/transport");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(root, "packages/daemon/src/daemon-host-repository-api.ts"), "export {};\n");
    writeFileSync(path.join(nested, "new-rpc.ts"), fixture);
    const errors = checkFleetTransferBoundary(root);
    assert.deepEqual(errors, [
      "packages/daemon/src/fleet/new/transport/new-rpc.ts:4: direct JSON socket write",
      "packages/daemon/src/fleet/new/transport/new-rpc.ts:5: JSON payload reaches socket.write through a variable",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the gate catches socket aliases and stringify wrappers", () => {
  const violations = findFleetTransferBypasses(
    `const writer = socket;
const encodeReply = (value) => JSON.stringify(value);
writer.write(encodeReply(reply));`,
    "alias-wrapper-negative-fixture.ts",
  );
  assert.deepEqual(violations, [
    {
      file: "alias-wrapper-negative-fixture.ts",
      line: 3,
      reason: "JSON payload reaches socket.write through a variable",
    },
  ]);
});

test("the gate catches a wrapper result assigned before the socket write", () => {
  const violations = findFleetTransferBypasses(
    `const stringifyReply = (value) => JSON.stringify(value);
const line = stringifyReply(reply);
socket.write(line);`,
    "wrapper-assignment-negative-fixture.ts",
  );
  assert.deepEqual(violations, [
    {
      file: "wrapper-assignment-negative-fixture.ts",
      line: 3,
      reason: "JSON payload reaches socket.write through a variable",
    },
  ]);
});

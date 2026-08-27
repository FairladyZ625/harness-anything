// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { validateTestQuarantine } from "./test-quarantine.mjs";

test("test quarantine requires an owner task", () => {
  assert.match(
    validateTestQuarantine({
      schema: "harness-test-quarantine/v1",
      tests: [{ test: "a", quarantinedAt: "2026-08-27" }],
    }).join("\n"),
    /ownerTask/u,
  );
});

test("test quarantine accepts a dated owner-backed entry", () => {
  assert.deepEqual(
    validateTestQuarantine({
      schema: "harness-test-quarantine/v1",
      tests: [{ test: "a", ownerTask: "task_abc123", quarantinedAt: "2026-08-27" }],
    }),
    [],
  );
});

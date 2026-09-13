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
      tests: [{ test: "a", ownerTask: "task_f9443002d6d995489ebf082911", quarantinedAt: "2026-08-27" }],
    }),
    [],
  );
});

test("test quarantine ownerTask must be one of the two real task id shapes", () => {
  for (const ownerTask of ["task_f9443002d6d995489ebf082911", "task_01KWVTPX3AH5TG8VK4RJYXE7EZ"]) {
    assert.deepEqual(
      validateTestQuarantine({
        schema: "harness-test-quarantine/v1",
        tests: [{ test: "a", ownerTask, quarantinedAt: "2026-08-27" }],
      }),
      [],
      ownerTask,
    );
  }

  for (const ownerTask of [
    "task_abc123",
    "task_2301",
    "task_f7cc215a54a194898ad733c20",
    "task_01kwvtpx3ah5tg8vk4rjyxe7ez",
  ]) {
    assert.match(
      validateTestQuarantine({
        schema: "harness-test-quarantine/v1",
        tests: [{ test: "a", ownerTask, quarantinedAt: "2026-08-27" }],
      }).join("\n"),
      /ownerTask/u,
      ownerTask,
    );
  }
});

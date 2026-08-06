// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { WriteError } from "@harness-anything/kernel";
import { preserveWriteErrorOrUnclassified } from "../src/cli/write-error-classification.ts";

test("caught public write errors retain their identity", () => {
  const error = {
    _tag: "WriteRejected",
    code: "authored_root_not_isolated",
    reason: "authored root is not isolated",
    retryable: false
  } as const satisfies WriteError;

  assert.equal(preserveWriteErrorOrUnclassified(error), error);
});

test("caught kernel write rejection exceptions retain semantic and retry fields", () => {
  assert.deepEqual(preserveWriteErrorOrUnclassified({
    _tag: "WriteRejectedError",
    reason: "watermark changed",
    code: "cas_watermark_mismatch",
    retryable: true,
    currentWatermark: "current",
    expectedWatermark: "expected"
  }), {
    _tag: "WriteRejected",
    reason: "watermark changed",
    code: "cas_watermark_mismatch",
    retryable: true,
    currentWatermark: "current",
    expectedWatermark: "expected"
  });
});

test("unknown caught failures are explicitly unclassified", () => {
  assert.deepEqual(preserveWriteErrorOrUnclassified(new Error("fixture exploded")), {
    _tag: "WriteRejected",
    code: "unclassified_command_failure",
    reason: "fixture exploded"
  });
});

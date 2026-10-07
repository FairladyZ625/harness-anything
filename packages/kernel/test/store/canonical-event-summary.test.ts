// harness-test-tier: fast
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalEventSummary } from "../../src/domain/canonical-event-summary.ts";

test("event summary omits unbounded payload fields before replica publication", () => {
  const event = {
    eventId: "inside",
    schema: "ci-run-observation-event/v3",
    type: "ci_run_observed",
    occurredAt: "2026-09-20T00:01:00.000Z",
    workspaceRevision: 2,
    taskId: "member",
    payload: {
      title: "inside",
      tests: Array.from({ length: 2407 }, (_, index) => ({
        name: `test-${index}`,
        output: "x".repeat(200),
      })),
    },
  };
  const result = canonicalEventSummary(event as never);
  assert.equal(result.eventId, "inside");
  assert.equal(JSON.stringify(result).includes("test-2406"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2000);
});

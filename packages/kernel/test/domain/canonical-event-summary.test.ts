// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalEventFleetSummary } from "../../src/domain/canonical-event-summary.ts";

test("fleet event summary stays bounded for large documentClaims and clips long text", () => {
  const summary = canonicalEventFleetSummary({
    eventId: "event-large",
    schema: "task-event/v1",
    type: "execution_submitted",
    occurredAt: "2026-11-05T00:00:00.000Z",
    workspaceRevision: 1,
    payload: {
      title: "x".repeat(10_000),
      documentClaims: Array.from({ length: 10_000 }, (_, index) => ({ path: `docs/${index}.md` })),
    },
  } as never);
  const serialized = JSON.stringify(summary);
  assert.ok(Buffer.byteLength(serialized) < 1_024, `fleet summary was ${Buffer.byteLength(serialized)} bytes`);
  assert.equal("documentClaims" in (summary.payload as Record<string, unknown>), false);
  assert.equal((summary.payload.title as string).length, 280);
});

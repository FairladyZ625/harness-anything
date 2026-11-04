// harness-test-tier: fast
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runFleetEdgeTaskCommand } from "../src/fleet-edge-write.ts";

test("a task command retry calls the same write closure, so the entry-minted request id is reused", async () => {
  const requestOpId = randomUUID(),
    observed: string[] = [];
  let attempts = 0;
  const result = await runFleetEdgeTaskCommand({
    timeoutMs: 5_000,
    readOnly: false,
    write: async () => {
      attempts += 1;
      // Production callers mint the request id before this closure and capture it here.
      observed.push(requestOpId);
      if (attempts === 1) throw Object.assign(new Error("Fleet connection closed"), { code: "ECONNRESET" });
      return { outcome: "applied", replicationSequence: null } as const;
    },
  });

  assert.equal(result.outcome, "applied");
  assert.equal(attempts, 2, "the transport failure retried the one command");
  assert.deepEqual(observed, [requestOpId, requestOpId], "the retry reuses the same request id");
});

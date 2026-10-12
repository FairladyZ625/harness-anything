// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { watchReplicaHead } from "../src/fleet/edge-replica-watch.ts";

test("replica watch forwards the heartbeat deadline to the session", async () => {
  let observedTimeout: number | null | undefined;
  const session = {
    messageId: () => "watch-1",
    send: async () => {},
    next: async (timeoutMs?: number | null) => {
      observedTimeout = timeoutMs;
      return {
        schema: "fleet.replica.head-hint/v1" as const,
        messageId: "hint-1",
        inReplyTo: "watch-1",
        repoId: "repo",
        cut: { revision: 1, headDigest: "sha256:" + "a".repeat(64), schemaGeneration: 1 },
        knownHead: { revision: 1, headDigest: "sha256:" + "a".repeat(64), schemaGeneration: 1 },
      };
    },
  };
  await watchReplicaHead(session, "repo", 0, 1234);
  assert.equal(observedTimeout, 1234);
});

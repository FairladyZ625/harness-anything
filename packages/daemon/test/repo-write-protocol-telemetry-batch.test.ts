// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRepoWriteChildMessage,
  repoWriteProtocolType,
  stringifyRepoWriteChildMessage,
  type RepoWriteChildMessage
} from "../src/runtime/repo-write-protocol.ts";

test("telemetry batch codec preserves every ordered phase boundary", () => {
  const batch: RepoWriteChildMessage = {
    protocol: repoWriteProtocolType,
    repoId: "repo-canonical",
    generation: 7,
    kind: "telemetry-batch",
    requestId: "request-telemetry-batch",
    opId: "op-telemetry-batch",
    spans: [
      { phase: "queue", elapsedMs: 0 },
      { phase: "git", elapsedMs: 12.5, details: { pathCount: 3, clean: true } },
      { phase: "child-terminal-response", elapsedMs: 13 }
    ]
  };

  assert.deepEqual(
    parseRepoWriteChildMessage(stringifyRepoWriteChildMessage(batch)),
    batch
  );
});

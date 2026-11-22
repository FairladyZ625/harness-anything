// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { validateCollaboratorTokenUsage } from "../src/daemon-host/collaborator-token-usage-read.ts";

test("collaborator token usage accepts the person/node result contract and rejects malformed totals", () => {
  const totals = {
    dispatches: 1,
    usageReportedDispatches: 1,
    inputTokens: 3,
    cacheReadTokens: 1,
    outputTokens: 2,
    totalTokens: 6,
    toolCallCount: 1,
  };
  const result = {
    ok: true,
    groupBy: "person",
    status: "ready",
    watermark: 4,
    sourceRevision: 4,
    totals,
    byPerson: [{ personId: "person-1", ...totals }],
    byNode: [{ nodeId: "node-1", ...totals }],
  };

  assert.deepEqual(validateCollaboratorTokenUsage(result), []);
  assert.deepEqual(
    validateCollaboratorTokenUsage({ ...result, byNode: [{ nodeId: "node-1", ...totals, totalTokens: -1 }] }),
    ["collaborator token usage is invalid"],
  );
  assert.deepEqual(validateCollaboratorTokenUsage({ ...result, groupBy: "task" }), [
    "collaborator token usage is invalid",
  ]);
});

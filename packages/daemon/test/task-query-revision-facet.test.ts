// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonRpcParams } from "../src/protocol/daemon-protocol.contract.ts";

const task = (payload: Record<string, unknown>) => parseDaemonRpcParams("repo.tasks.list", { repo: { repoId: "alpha" }, payload });
const graph = (payload: Record<string, unknown>) => parseDaemonRpcParams("repo.triadic.relationGraph", { repo: { repoId: "alpha" }, payload });

test("changedAfterRevision is a non-negative integer facet on task list queries only", () => {
  assert.equal(task({ changedAfterRevision: 0 }).ok, true);
  assert.equal(task({ changedAfterRevision: 42 }).ok, true);
  assert.equal(task({ status: "blocked", changedAfterRevision: 42, updatedAfter: "2026-08-01T00:00:00.000Z", updatedBefore: "2026-08-31T00:00:00.000Z", limit: 25, cursor: "WyJ0YXNrLTEiXQ" }).ok, true);
  assert.equal(task({ changedAfterRevision: -1 }).ok, false);
  assert.equal(task({ changedAfterRevision: 1.5 }).ok, false);
  assert.equal(task({ changedAfterRevision: "42" }).ok, false);
  assert.equal(graph({ changedAfterRevision: 42 }).ok, false);
});

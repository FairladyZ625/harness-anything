// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { queryPayloadValidation } from "@harness-anything/kernel/internal/domain/query-payload-validation.ts";
import { validateDaemonRpcCall } from "../src/protocol/daemon-protocol-rpc-validation.ts";
import { validateDaemonQueryPayload } from "../src/protocol/daemon-protocol-validate-relation-query.ts";

test("daemon query payload and RPC validation delegate shared facet rules to kernel queryPayloadValidation", () => {
  const repo = { repoId: "repo-1" };

  for (const method of ["repo.tasks.list", "repo.triadic.relationGraph", "repo.artifacts.list"] as const) {
    assert.deepEqual(validateDaemonQueryPayload(method, undefined), []);
    assert.deepEqual(validateDaemonRpcCall({ method, params: { repo, payload: {} } }), []);
    assert.deepEqual(validateDaemonQueryPayload(method, "bad"), ["query payload must be an object"]);
  }

  // Task list query payload shares exact status, changedAfterRevision, UTC time window, limit, and cursor rules.
  const validTaskPayload = {
    status: "active",
    changedAfterRevision: 0,
    updatedAfter: "2026-09-06T00:00:00Z",
    updatedBefore: "2026-09-06T01:00:00Z",
    limit: 500,
    cursor: "cursor-1",
  };
  assert.deepEqual(queryPayloadValidation("task-list", validTaskPayload), []);
  assert.deepEqual(validateDaemonQueryPayload("repo.tasks.list", validTaskPayload), []);
  assert.deepEqual(
    validateDaemonRpcCall({ method: "repo.tasks.list", params: { repo, payload: validTaskPayload } }),
    [],
  );

  for (const [payload, expectedError] of [
    [{ status: "in_progress" }, "repo.tasks.list.payload.status is invalid"],
    [{ changedAfterRevision: -1 }, "repo.tasks.list.payload.changedAfterRevision is invalid"],
    [{ changedAfterRevision: 1.5 }, "repo.tasks.list.payload.changedAfterRevision is invalid"],
    [{ updatedAfter: "not-a-timestamp" }, "repo.tasks.list.payload time window is invalid"],
    [
      { updatedAfter: "2026-09-06T02:00:00Z", updatedBefore: "2026-09-06T01:00:00Z" },
      "repo.tasks.list.payload time window is invalid",
    ],
    [{ limit: 0 }, "repo.tasks.list.payload.limit is invalid"],
    [{ limit: 501 }, "repo.tasks.list.payload.limit is invalid"],
  ] as const) {
    assert.deepEqual(validateDaemonQueryPayload("repo.tasks.list", payload), [expectedError]);
    assert.deepEqual(validateDaemonRpcCall({ method: "repo.tasks.list", params: { repo, payload } }), [expectedError]);
  }
  for (const method of ["repo.tasks.list", "repo.triadic.relationGraph", "repo.artifacts.list"] as const) {
    assert.deepEqual(validateDaemonQueryPayload(method, { cursor: "" }), [`${method}.payload.cursor is invalid`]);
    assert.deepEqual(validateDaemonQueryPayload(method, { cursor: 123 }), [`${method}.payload.cursor is invalid`]);
    assert.deepEqual(validateDaemonRpcCall({ method, params: { repo, payload: { cursor: "" } } }), [
      "params.payload.cursor must be string",
    ]);
  }

  // Relation graph legacy page, entity page, facet selectors, and neighborhood selectors keep closed wire routing
  // while delegating shared pagination/status/window rules to queryPayloadValidation.
  const validRelationLegacy = {
    status: "active",
    updatedAfter: "2026-09-06T00:00:00Z",
    updatedBefore: "2026-09-06T00:00:00Z",
    limit: 1,
    cursor: "edge-cursor",
  };
  assert.deepEqual(queryPayloadValidation("relation-graph", validRelationLegacy), []);
  assert.deepEqual(validateDaemonQueryPayload("repo.triadic.relationGraph", validRelationLegacy), []);
  assert.deepEqual(
    validateDaemonRpcCall({ method: "repo.triadic.relationGraph", params: { repo, payload: validRelationLegacy } }),
    [],
  );

  assert.deepEqual(validateDaemonQueryPayload("repo.triadic.relationGraph", { changedAfterRevision: 1 }), [
    'repo.triadic.relationGraph.payload contains an unknown field "changedAfterRevision"; allowed fields: "status", "updatedAfter", "updatedBefore", "limit", "cursor".',
  ]);
  assert.deepEqual(
    validateDaemonQueryPayload("repo.triadic.relationGraph", { entity: "task_1", status: "active", limit: 25 }),
    [],
  );
  assert.deepEqual(
    validateDaemonQueryPayload("repo.triadic.relationGraph", { entity: "task_1", status: "in_progress" }),
    ["repo.triadic.relationGraph.payload.status is invalid"],
  );
  assert.deepEqual(
    validateDaemonQueryPayload("repo.triadic.relationGraph", {
      facet: "edges",
      relationType: "governs",
      state: "active",
      direction: "directed",
      limit: 500,
    }),
    [],
  );
  assert.deepEqual(validateDaemonQueryPayload("repo.triadic.relationGraph", { facet: "facts", limit: 501 }), [
    "repo.triadic.relationGraph.payload.limit is invalid",
  ]);
  assert.deepEqual(
    validateDaemonQueryPayload("repo.triadic.relationGraph", {
      entity: "task_1",
      hops: { direction: "both", relationTypes: ["governs"], maxDepth: 2, maxNodes: 100 },
    }),
    [],
  );

  // Artifacts list reuses the relation-graph non-task query validation kind over closed artifact pagination fields.
  assert.deepEqual(
    validateDaemonRpcCall({ method: "repo.artifacts.list", params: { repo, payload: { limit: 50 } } }),
    [],
  );
  assert.deepEqual(validateDaemonRpcCall({ method: "repo.artifacts.list", params: { repo, payload: { limit: 0 } } }), [
    "repo.artifacts.list.payload.limit is invalid",
  ]);
});

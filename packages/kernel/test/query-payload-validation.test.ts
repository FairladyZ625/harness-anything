// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { queryPayloadValidation } from "../src/domain/query-payload-validation.ts";

test("query payload validation accepts task and relation query facets", () => {
  assert.deepEqual(
    queryPayloadValidation("task-list", {
      status: "blocked",
      changedAfterRevision: 0,
      updatedAfter: "2026-08-01T00:00:00.000Z",
      updatedBefore: "2026-08-31T00:00:00.000Z",
      limit: 500,
      cursor: "next-page",
    }),
    [],
  );
  assert.deepEqual(queryPayloadValidation("relation-graph", { status: "retired", limit: 1 }), []);
});

test("query payload validation owns status, revision, time, limit, and cursor rules", () => {
  assert.deepEqual(
    queryPayloadValidation("task-list", {
      status: "retired",
      changedAfterRevision: -1,
      updatedAfter: "2026-09-01T00:00:00.000Z",
      updatedBefore: "2026-08-01T00:00:00.000Z",
      limit: 0,
      cursor: "",
    }),
    ["status_invalid", "changed_after_revision_invalid", "time_window_invalid", "limit_invalid", "cursor_invalid"],
  );
  assert.deepEqual(queryPayloadValidation("relation-graph", { changedAfterRevision: -1 }), []);
  assert.deepEqual(queryPayloadValidation("task-list", []), ["payload_not_object"]);
});

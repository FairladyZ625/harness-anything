// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { validateEntityActionExplainRequest } from "../src/protocol/daemon-protocol-rpc-validation.ts";

test("Entity Action explain request is exact and caps object batches at 500 refs", () => {
  assert.deepEqual(
    validateEntityActionExplainRequest({
      schema: "entity-action-explain-request/v1",
      mode: "object",
      refs: Array.from({ length: 500 }, () => "task/task-1"),
    }),
    [],
  );
  assert.match(
    validateEntityActionExplainRequest({
      schema: "entity-action-explain-request/v1",
      mode: "object",
      refs: Array.from({ length: 501 }, () => "task/task-1"),
    }).join("\n"),
    /1\.\.500/u,
  );
  assert.match(
    validateEntityActionExplainRequest({
      schema: "entity-action-explain-request/v1",
      mode: "catalog",
      refs: [],
      actor: { principal: { personId: "person-explain" }, executor: null },
    }).join("\n"),
    /unknown/u,
  );
});

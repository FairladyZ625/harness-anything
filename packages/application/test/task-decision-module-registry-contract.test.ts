// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { entityRegistry } from "../../kernel/src/index.ts";

test("task/decision register W5 semanticDiff while non-markdown module stays typed-only", () => {
  assert.deepEqual(entityRegistry.task.mutationContract, { status: "ready", actions: ["create", "transition", "append", "document"] });
  assert.deepEqual(entityRegistry.decision.mutationContract, { status: "ready", actions: ["propose", "state", "amend", "relation"] });
  assert.deepEqual(entityRegistry.module.mutationContract, { status: "ready", actions: ["register", "unregister", "step"] });
  assert.equal(entityRegistry.task.semanticDiff.status, "ready");
  assert.equal(entityRegistry.decision.semanticDiff.status, "ready");
  assert.equal(entityRegistry.module.semanticDiff.status, "typed-only");
  assert.equal(entityRegistry.module.projectionFacet.status, "ready");
  assert.deepEqual(entityRegistry.module.projectionFacet.status === "ready"
    ? entityRegistry.module.projectionFacet.attributionTarget
    : null, {
    table: "module_attribution_projection",
    idColumn: "module_key",
    identityField: "moduleKey",
    materialization: "mutation-index"
  });
});

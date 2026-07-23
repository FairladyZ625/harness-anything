// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { disposeExtensionResources, registerExtensionResource } from "../src/extension/lifecycle.ts";

test("extension disposal is bounded and invokes dispose without terminal termination", async () => {
  const calls: string[] = [];
  registerExtensionResource({ dispose: async () => {
    calls.push("dispose");
    await new Promise(() => undefined);
  } });
  await disposeExtensionResources(5);
  assert.deepEqual(calls, ["dispose"]);
  assert.equal(calls.includes("terminate"), false);
});

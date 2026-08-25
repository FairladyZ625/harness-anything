// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { jsonRpcMethodContracts } from "../src/protocol/daemon-protocol.contract.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";

test("every JSON-RPC method has structured lifecycle version metadata", () => {
  assert.ok(jsonRpcMethodContracts.length > 0);
  for (const contract of jsonRpcMethodContracts) {
    assert.deepEqual(contract.sinceVersion, currentDaemonProtocolVersion, contract.method);
    assert.equal(contract.deprecatedSince, null, contract.method);
  }
});

test("context is absent because no production context contract or handler exists", () => {
  assert.equal(
    jsonRpcMethodContracts.some(({ method }) => method === "context" || method.endsWith(".context")),
    false,
  );
});

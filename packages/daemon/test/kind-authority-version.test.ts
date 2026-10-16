// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { jsonRpcMethodContracts } from "../src/protocol/daemon-protocol.contract.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import type { DaemonHost } from "../src/daemon-host.ts";

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

test("hello advertises runtime hosting credential methods", async () => {
  const server = createJsonRpcProtocolServer({
    host: {} as DaemonHost,
    build: { commit: "test-build" },
    authContext: { transportKind: "unix-socket" },
    emit: async () => {},
  });
  try {
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion },
    });
    assert.ok(response && !Array.isArray(response) && "result" in response);
    const methods = (response.result as { readonly methods: readonly string[] }).methods;
    assert.ok(methods.includes("daemon.runtimeInstance.hostingCredential.set"));
    assert.ok(methods.includes("daemon.runtimeInstance.hostingCredential.unset"));
  } finally {
    server.close();
  }
});

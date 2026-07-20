// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  daemonProtocolHandlerViolations,
  isDaemonProtocolHandler
} from "./implementation-contract-daemon-protocol.mjs";

test("daemon protocol contract classifies protocol neighborhoods and registered handlers", () => {
  assert.equal(isDaemonProtocolHandler("packages/daemon/src/protocol/json-rpc-server.ts"), true);
  assert.equal(isDaemonProtocolHandler("packages/daemon/src/authority/forced-command-session.ts"), true);
  assert.equal(isDaemonProtocolHandler("packages/daemon/src/authority/production/publication-evidence.ts"), false);
});

test("daemon protocol contract still rejects status-derived business state in handlers", () => {
  const source = `if (result.status === "active") return result;`;
  assert.deepEqual(
    daemonProtocolHandlerViolations("packages/daemon/src/protocol/example-handler.ts", source),
    ["packages/daemon/src/protocol/example-handler.ts: daemon protocol handlers must not infer business state from status values"]
  );
  assert.deepEqual(
    daemonProtocolHandlerViolations("packages/daemon/src/authority/production/publication-evidence.ts", source),
    []
  );
});

test("daemon protocol contract keeps direct implementation and write bans active", () => {
  const source = [
    `import { adapter } from "@harness-anything/adapter-local";`,
    `coordinator.enqueue(operation);`
  ].join("\n");
  assert.deepEqual(
    daemonProtocolHandlerViolations("packages/daemon/src/protocol/example-handler.ts", source),
    [
      "packages/daemon/src/protocol/example-handler.ts: daemon protocol handlers must not import store or adapter implementations",
      "packages/daemon/src/protocol/example-handler.ts: daemon protocol handlers must not perform write coordination or authored writes directly"
    ]
  );
});

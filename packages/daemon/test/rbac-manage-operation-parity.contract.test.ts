// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { daemonProtocolMethods } from "../src/protocol/daemon-protocol.contract.ts";
import { agentProtocolCommands } from "../src/protocol/daemon-protocol-commands-agent.ts";
import { validateShape } from "../src/protocol/daemon-protocol-gui-types.ts";

test("every ha bootstrap --operation the CLI offers is accepted by daemon.rbac.manage", () => {
  const command = agentProtocolCommands.find((entry) => entry.id === "rbac-bootstrap");
  const operationInput = command?.inputs.find((input) => input.name === "--operation") as
    | { enum?: readonly string[] }
    | undefined;
  const descriptor = daemonProtocolMethods.find((entry) => entry.method === "daemon.rbac.manage");
  assert.ok(operationInput?.enum?.length && descriptor);
  const rejected = operationInput.enum.filter(
    (operation) => validateShape({ operation }, descriptor.params, "params").length > 0,
  );
  assert.deepEqual(rejected, []);
});

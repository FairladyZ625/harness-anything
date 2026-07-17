// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryTerminalSessionService } from "../src/terminal/session-registry.ts";
import { jsonRpcMethodContracts, type JsonRpcRequest } from "../src/index.ts";
import { emptyLocalController, makeServer, resultReceipt } from "./json-rpc-protocol-fixtures.ts";

test("agent runtime inventory route is contract-derived and returns the safe application projection", async () => {
  const controller = {
    ...emptyLocalController(),
    getAgentRuntimes: async () => ({
      ok: true as const,
      schema: "agent-runtime-inventory-projection/v1" as const,
      generatedAt: "2026-07-17T12:00:00.000Z",
      rebuildable: true as const,
      kinds: [],
      installations: [],
      sessions: []
    })
  };
  const server = makeServer({
    services: {
      LocalControllerService: controller,
      TerminalSessionService: createInMemoryTerminalSessionService()
    }
  });
  await server.handle({
    jsonrpc: "2.0",
    id: "hello",
    method: "protocol.hello",
    params: { protocolVersion: 1 }
  });
  const request = {
    jsonrpc: "2.0",
    id: "runtime-inventory",
    method: "repo.agent-runtimes.inventory",
    params: { repo: { repoId: "canonical" }, payload: {} }
  } satisfies JsonRpcRequest;

  const receipt = resultReceipt(await server.handle(request));

  assert.equal(jsonRpcMethodContracts.some(({ method }) => method === request.method), true);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.details.data.schema, "agent-runtime-inventory-projection/v1");
  assert.equal(receipt.details.data.rebuildable, true);
});

test("agent runtime spawn route dispatches only through the daemon-owned control service", async () => {
  const calls: unknown[] = [];
  const controller = {
    ...emptyLocalController(),
    spawn: async (payload: unknown) => {
      calls.push(payload);
      return { ok: false as const, error: { code: "runtime_spawn_fixture", hint: "fixture rejection" } };
    }
  };
  const server = makeServer({
    services: {
      LocalControllerService: controller,
      TerminalSessionService: createInMemoryTerminalSessionService()
    }
  });
  await server.handle({ jsonrpc: "2.0", id: "hello", method: "protocol.hello", params: { protocolVersion: 1 } });
  const response = resultReceipt(await server.handle({
    jsonrpc: "2.0",
    id: "spawn",
    method: "repo.agent-runtimes.spawn",
    params: {
      repo: { repoId: "canonical" },
      payload: { kindId: "codex", prompt: "inspect", cwd: "/tmp/canonical", authenticationProfileKind: "chatgpt-account" }
    }
  }));

  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "runtime_spawn_fixture");
  assert.equal(calls.length, 1);
});

test("agent holder projection route is contract-derived and forwards the optional task filter", async () => {
  const calls: unknown[] = [];
  const controller = {
    ...emptyLocalController(),
    getAgentHolders: async (payload: unknown) => {
      calls.push(payload);
      return { ok: true as const, schema: "agent-holder-projection/v1" as const, rebuildable: true as const, rows: [] };
    }
  };
  const server = makeServer({
    services: {
      LocalControllerService: controller,
      TerminalSessionService: createInMemoryTerminalSessionService()
    }
  });
  await server.handle({ jsonrpc: "2.0", id: "hello", method: "protocol.hello", params: { protocolVersion: 1 } });
  const request = {
    jsonrpc: "2.0",
    id: "agent-holders",
    method: "repo.agent-holders.projection",
    params: { repo: { repoId: "canonical" }, payload: { taskId: "task_01KXQJZM9Z86FSJBT7Q4FEA6AB" } }
  } satisfies JsonRpcRequest;

  const receipt = resultReceipt(await server.handle(request));

  assert.equal(jsonRpcMethodContracts.some(({ method }) => method === request.method), true);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.details.data.schema, "agent-holder-projection/v1");
  assert.deepEqual(calls, [{ taskId: "task_01KXQJZM9Z86FSJBT7Q4FEA6AB" }]);
});

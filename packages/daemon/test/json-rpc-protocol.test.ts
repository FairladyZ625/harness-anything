import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { LocalControllerService } from "../../application/src/index.ts";
import { apiRouteContracts } from "../../gui/src/api/api-contract-registry.ts";
import { createInMemoryTerminalSessionService } from "../../gui/src/terminal/session-registry.ts";
import {
  createJsonRpcProtocolServer,
  currentDaemonProtocolVersion,
  jsonRpcServiceMethodContracts,
  type JsonRpcRequest,
  type JsonRpcResponse
} from "../src/index.ts";

const fixtureRoot = path.resolve(fileURLToPath(new URL("../fixtures/protocol", import.meta.url)));

test("daemon JSON-RPC service method registry is derived from the API contract registry", () => {
  assert.deepEqual(
    jsonRpcServiceMethodContracts.map((contract) => ({
      method: contract.method,
      service: contract.service,
      serviceMethod: contract.serviceMethod,
      inputSchemaId: contract.inputSchemaId,
      outputSchemaId: contract.outputSchemaId
    })),
    apiRouteContracts.map((contract) => ({
      method: `repo.${contract.id}`,
      service: contract.service,
      serviceMethod: contract.serviceMethod,
      inputSchemaId: contract.inputSchemaId,
      outputSchemaId: contract.outputSchemaId
    }))
  );
});

test("protocol.hello accepts the current daemon protocol version", async () => {
  const server = makeServer();
  const response = await server.handle(readFixture("hello-compatible.json"));
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, true);
  assert.equal(receipt.schema, "command-receipt/v2");
  assert.equal(receipt.command, "protocol.hello");
  assert.equal(receipt.details.data.protocolVersion, currentDaemonProtocolVersion);
  assert.deepEqual(receipt.details.data.repos, [{ repoId: "canonical", canonicalRoot: "/tmp/canonical" }]);
  const methods = receipt.details.data.methods as ReadonlyArray<string>;
  assert.equal(methods.includes("repo.tasks.list"), true);
  assert.equal(methods.includes("admin.people.list"), true);
});

test("protocol.hello rejects incompatible daemon protocol versions with receipt/v2 evidence", async () => {
  const server = makeServer();
  const response = await server.handle(readFixture("hello-incompatible.json"));
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, false);
  assert.equal(receipt.schema, "command-receipt/v2");
  assert.equal(receipt.command, "protocol.hello");
  assert.equal(receipt.error.code, "incompatible_protocol_version");
  assert.equal(receipt.details.supported?.currentProtocolVersion, currentDaemonProtocolVersion);
});

test("repo methods require hello before service dispatch", async () => {
  const server = makeServer();
  const response = await server.handle(readFixture("repo-request.json"));
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.code, "hello_required");
});

test("repo methods require a known repo namespace and wrap service output in command-receipt/v2", async () => {
  const server = makeServer();
  await server.handle(readFixture("hello-compatible.json"));

  const response = await server.handle(readFixture("repo-request.json"));
  const receipt = resultReceipt(response);
  const fixtureReceipt = readJson("receipt-success.json");

  assert.equal(receipt.ok, true);
  assert.equal(receipt.schema, fixtureReceipt.schema);
  assert.equal(receipt.command, fixtureReceipt.command);
  assert.equal(receipt.action, fixtureReceipt.action);
  assert.deepEqual(receipt.items, fixtureReceipt.items);
  const fixtureDetails = fixtureReceipt.details as { readonly data: Record<string, unknown> };
  assert.deepEqual(receipt.details.data, fixtureDetails.data);
});

test("repo namespace rejects unknown canonical repositories", async () => {
  const server = makeServer();
  await server.handle(readFixture("hello-compatible.json"));

  const request = {
    ...readFixture("repo-request.json"),
    params: { repo: { repoId: "missing" }, payload: {} }
  } satisfies JsonRpcRequest;
  const response = await server.handle(request);
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.code, "repo_namespace_unknown");
});

test("notification subscribe is a no-op socket and respects JSON-RPC notification semantics", async () => {
  const server = makeServer();
  await server.handle(readFixture("hello-compatible.json"));

  const response = await server.handle(readFixture("notification-subscribe.json"));

  assert.equal(response, undefined);
});

test("admin namespace is reserved and explicitly rejected until W4 owns it", async () => {
  const server = makeServer();
  await server.handle(readFixture("hello-compatible.json"));

  const response = await server.handle({
    jsonrpc: "2.0",
    id: "admin-1",
    method: "admin.people.list",
    params: {}
  });
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.code, "method_reserved");
});

function makeServer() {
  const localController: LocalControllerService = {
    getTasks: () => ({ ok: true, tasks: [], warnings: [] }),
    getTaskDetail: () => ({ ok: true }),
    getTaskDocument: () => ({ ok: true }),
    setTaskStatus: async () => ({ ok: true }),
    reviewTask: async () => ({ ok: true }),
    appendTaskProgress: async () => ({ ok: true }),
    rebuildGovernance: () => ({ ok: true, tasks: [], warnings: [] }),
    archiveTask: () => ({ ok: true }),
    openShell: () => ({ ok: true, policy: { displayOnly: true, outputCreatesTaskState: false } })
  };

  return createJsonRpcProtocolServer({
    daemonId: "daemon-test",
    repos: [{ repoId: "canonical", canonicalRoot: "/tmp/canonical" }],
    services: {
      LocalControllerService: localController,
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" })
    }
  });
}

function readFixture(name: string): JsonRpcRequest {
  return readJson(name) as JsonRpcRequest;
}

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixtureRoot, name), "utf8"));
}

function resultReceipt(response: JsonRpcResponse | ReadonlyArray<JsonRpcResponse> | undefined): {
  readonly ok: boolean;
  readonly schema: string;
  readonly command: string;
  readonly action?: string;
  readonly error?: { readonly code?: string };
  readonly items?: ReadonlyArray<unknown>;
  readonly details: Record<string, Record<string, unknown>>;
} {
  assert.ok(response && !Array.isArray(response));
  assert.equal("result" in response, true);
  return response.result as {
    readonly ok: boolean;
    readonly schema: string;
    readonly command: string;
    readonly action?: string;
    readonly error?: { readonly code?: string };
    readonly items?: ReadonlyArray<unknown>;
    readonly details: Record<string, Record<string, unknown>>;
  };
}

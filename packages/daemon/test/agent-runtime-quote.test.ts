// harness-test-tier: integration
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLOUD_CODE_RESERVE_MICROS,
  OUTPUT_CAP_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
  costMicros,
  inputTokenEstimate,
  quoteAgentRuntimeBudget,
} from "../src/runtime/cloud-dispatch-relay.ts";
import { modelPriceOf, modelPricingVersion } from "../src/agent-runtime-model-pricing.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { daemonProtocolMethods, parseDaemonRpcParams } from "../src/protocol/daemon-protocol.contract.ts";
import type { JsonObject, JsonRpcResponse } from "../src/protocol/json-rpc-types.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { serveJsonRpcStream } from "../src/transport/json-rpc-stream.ts";

function responseResult(response: JsonRpcResponse): JsonObject {
  assert.ok("result" in response, "daemon response must be a protocol result");
  return response.result as JsonObject;
}

function quoteServer(authContext: {
  readonly transportKind: "unix-socket" | "fleet-tls";
  readonly nodePrincipal?: { readonly nodeId: string; readonly personId: string };
}) {
  return createJsonRpcProtocolServer({
    host: {} as never,
    build: { commit: null },
    authContext,
    emit: async () => undefined,
  });
}

test("quotes token input from the daemon-owned price table", () => {
  const price = modelPriceOf("gpt-6.1-sol");
  assert.ok(price);
  const quote = quoteAgentRuntimeBudget({ model: "gpt-6.1-sol", inputTokens: 1_000, outputCapTokens: 100 });
  assert.deepEqual(quote, {
    ok: true,
    model: "gpt-6.1-sol",
    pricing: { ...price, version: modelPricingVersion },
    inputTokens: 1_000 + REQUEST_OVERHEAD_TOKENS,
    inputBytes: null,
    outputCapTokens: 100,
    codeRun: false,
    strategy: "single-request",
    reserveMicros: String(
      costMicros(price, {
        input: 1_000 + REQUEST_OVERHEAD_TOKENS,
        cachedInput: 0,
        output: 100,
      }),
    ),
  });
});

test("quotes byte input and applies the fixed code-run floor", () => {
  const price = modelPriceOf("GLM-5.3");
  assert.ok(price);
  const quote = quoteAgentRuntimeBudget({ model: "GLM-5.3", inputBytes: 5, outputCapTokens: 1, codeRun: true });
  const single = costMicros(price, {
    input: inputTokenEstimate(5) + REQUEST_OVERHEAD_TOKENS,
    cachedInput: 0,
    output: 1,
  });
  assert.equal(quote.inputBytes, 5);
  assert.equal(quote.inputTokens, inputTokenEstimate(5) + REQUEST_OVERHEAD_TOKENS);
  assert.equal(quote.codeRun, true);
  assert.equal(quote.strategy, "code-run-floor");
  assert.equal(quote.reserveMicros, String(Math.max(single, CLOUD_CODE_RESERVE_MICROS)));
  assert.equal(quote.pricing.cacheWritePerMillion, price.cacheWritePerMillion);
});

test("unknown models fail closed instead of producing a zero-price quote", () => {
  assert.throws(() => quoteAgentRuntimeBudget({ model: "model-without-a-public-price", inputTokens: 1 }), {
    code: "MODEL_UNPRICED",
  });
});

test("quote input validation requires exactly one estimate and bounds output", () => {
  const valid = parseDaemonRpcParams("repo.agentRuntime.quote", {
    model: "gpt-6.1-sol",
    inputBytes: 4,
    outputCapTokens: OUTPUT_CAP_TOKENS,
  });
  assert.equal(valid.ok, true);
  for (const params of [
    { model: "gpt-6.1-sol" },
    { model: "gpt-6.1-sol", inputTokens: 1, inputBytes: 2 },
    { model: "gpt-6.1-sol", inputTokens: -1 },
    { model: "gpt-6.1-sol", inputTokens: 1, outputCapTokens: OUTPUT_CAP_TOKENS + 1 },
  ]) {
    const parsed = parseDaemonRpcParams("repo.agentRuntime.quote", params);
    assert.equal(parsed.ok, false, JSON.stringify(params));
  }
});

test("quote is advertised by protocol.hello and served on the local socket contract", async () => {
  const server = quoteServer({ transportKind: "unix-socket" });
  try {
    const hello = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion },
    });
    assert.ok(hello && !Array.isArray(hello));
    const helloResult = responseResult(hello);
    assert.equal(helloResult.ok, true);
    assert.ok(Array.isArray(helloResult.methods));
    assert.ok(helloResult.methods.includes("repo.agentRuntime.quote"));

    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "repo.agentRuntime.quote",
      params: { model: "gpt-6.1-sol", inputTokens: 10 },
    });
    assert.ok(response && !Array.isArray(response));
    const result = responseResult(response);
    assert.equal(result.ok, true);
    assert.equal(result.model, "gpt-6.1-sol");
    assert.equal(typeof result.reserveMicros, "string");
  } finally {
    server.close();
  }
});

test("quote rejects fleet TLS callers at the daemon ACL boundary", async () => {
  const server = quoteServer({
    transportKind: "fleet-tls",
    nodePrincipal: { nodeId: "edge-one", personId: "person-one" },
  });
  try {
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion },
    });
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "repo.agentRuntime.quote",
      params: { model: "gpt-6.1-sol", inputTokens: 10 },
    });
    assert.ok(response && !Array.isArray(response));
    const result = responseResult(response);
    assert.equal(result.ok, false);
    assert.equal(result.code, "local_transport_required");
  } finally {
    server.close();
  }
});

test("real Unix socket calls return priced and unpriced quote receipts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-agent-runtime-quote-")),
    socketPath = path.join(root, "daemon.sock"),
    listener = net.createServer((socket) => {
      serveJsonRpcStream({
        input: socket,
        output: socket,
        transportKind: "unix-socket",
        authContext: { transportKind: "unix-socket" },
        createProtocolServer: (authContext, emit, connectionId, signal) =>
          createJsonRpcProtocolServer({
            host: {} as never,
            build: { commit: null },
            authContext: { ...authContext, connectionSignal: signal },
            emit,
            connectionId,
          }),
      });
    });
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(socketPath, resolve);
    });
    const priced = await requestDaemonJsonRpcAt(
        socketPath,
        "repo.agentRuntime.quote",
        { model: "gpt-6.1-sol", inputTokens: 10 },
        2_000,
      ),
      unpriced = await requestDaemonJsonRpcAt(
        socketPath,
        "repo.agentRuntime.quote",
        { model: "model-without-a-public-price", inputTokens: 10 },
        2_000,
      );
    assert.equal(priced.ok, true);
    assert.equal(priced.model, "gpt-6.1-sol");
    assert.equal(typeof priced.reserveMicros, "string");
    assert.equal(unpriced.ok, false);
    assert.equal(unpriced.code, "MODEL_UNPRICED");
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the quote descriptor is a no-repository read-only method", () => {
  const descriptor = daemonProtocolMethods.find((entry) => entry.method === "repo.agentRuntime.quote");
  assert.ok(descriptor);
  assert.equal(descriptor.requiresRepo, false);
  assert.equal("commandClass" in descriptor, false);
});

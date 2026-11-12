// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { assertDaemonHello, daemonHelloParams } from "../src/client/daemon-hello.ts";
import { shape, validateShape } from "../src/protocol/daemon-protocol-gui-types.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";

// The hello schema of the previous release (98b51e9), frozen verbatim. The previous daemon is
// already running when a new CLI starts, so this is the object its closed validator sees: any new
// field is rejected with `unknown_field` before version negotiation can happen. Keep this copy
// until the 1.0 compatibility window closes (by 2026-12-04 or when the current minor becomes 1.1),
// then replace it with the 1.1 schema and bump the protocol minor.
const previousHelloParams = shape({
  protocolVersion: shape({ major: "number", minor: "number" }),
  sessionEnvironment: "json?",
  executionCredential: "string?",
  reportStaleBuild: "boolean?",
  invokingCommand: "string?",
});

/** The previous release's hello handler: closed-schema validation, then its bare success reply. */
function previousDaemonHello(params: unknown): JsonObject {
  const errors = validateShape(params, previousHelloParams, "params");
  assert.deepEqual(errors, [], "the previous daemon must accept the current client's hello params");
  return { ok: true };
}

test("a current client completes hello against the frozen previous-release contract", () => {
  const params = daemonHelloParams({
      sessionEnvironment: { cwd: "/tmp/worktree" },
      invokingCommand: "task.list",
      reportStaleBuild: true,
    }),
    reply = previousDaemonHello(params);

  assert.equal(params.buildCommit, undefined, "a hello field with no daemon consumer must not be sent");
  // The bare reply is exactly what the previous diagnostics worker returned; the main daemon shape
  // also reports the version. Both must be admitted without widening the window itself.
  assertDaemonHello(reply);
  assertDaemonHello({ ok: true, protocolVersion: currentDaemonProtocolVersion });
});

test("the round trip still refuses a peer outside the current/previous window", () => {
  assert.throws(
    () =>
      assertDaemonHello({
        ok: true,
        protocolVersion: { major: currentDaemonProtocolVersion.major, minor: currentDaemonProtocolVersion.minor + 1 },
      }),
    (error: unknown) => (error as { readonly code?: string }).code === "incompatible_protocol_version",
  );
});

test("a daemon rejection keeps its own code instead of becoming a version mismatch", () => {
  assert.throws(
    () =>
      assertDaemonHello({
        ok: false,
        code: "unknown_field",
        rejectionExplanation: 'params contains an unknown field "buildCommit"',
      }),
    (error: unknown) => (error as { readonly code?: string }).code === "unknown_field",
  );
});

test("lifecycle reads require an advertised connection opt-in; previous peers keep their closed DTO", async () => {
  const { makeAgentRuntimeReadModel } = await import("../src/agent-runtime-read.ts"),
    { createJsonRpcProtocolServer } = await import("../src/protocol/json-rpc-server.ts"),
    { parseDaemonGuiReadResponse } = await import("../src/protocol/gui-result-validation.ts");
  const session = {
    runtimeSessionId: "runtime-test",
    providerSessionId: null,
    instanceId: "worker",
    installationId: "installation-test",
    kindId: "codex",
    definitionSnapshotRef: "artifact:test",
    taskBindings: [],
    liveness: "live",
    outcome: null,
    exitCode: null,
    resultRef: null,
    lastObservedAt: "2026-11-12T00:00:00.000Z",
  };
  const projection = {
    readCut: () => ({ status: "ready", watermark: 2, sourceRevision: 2 }),
    readRuntimeSession: () => session,
    readRuntimeDispatch: () => null,
    readRuntimeInstallation: () => null,
    readRuntimeSessionEventsByType: () => [],
    readDispatchLifecycle: () => ({ status: "pending", watermark: 1, sourceRevision: 2 }),
  };
  const current = makeAgentRuntimeReadModel({ projection: projection as never, store: {} as never }).session({
    runtimeSessionId: session.runtimeSessionId,
  });
  const server = createJsonRpcProtocolServer({
    host: { read: async () => current } as never,
    build: { loadedBuildId: null, commit: null, builtAt: null },
    authContext: { transportKind: "unix-socket" },
    emit: async () => undefined,
  });
  const call = async (method: string, params: JsonObject = {}) => {
    const response = await server.handle({ jsonrpc: "2.0", id: 1, method, params });
    assert.ok(response && "result" in response);
    return response.result as JsonObject;
  };
  const hello = await call("protocol.hello", daemonHelloParams());
  assert.ok((hello.methods as string[]).includes("protocol.dispatchLifecycle.enable"));
  const params = { repo: { repoId: "repo-test" }, payload: { runtimeSessionId: session.runtimeSessionId } };
  const previous = await call("repo.agentRuntime.sessions.read", params);
  assert.equal((previous.session as JsonObject).lifecycle, undefined);
  // Frozen previous closed shape: the actual prior decoder is also run in the task's cross-version probe.
  const previousFields = new Set([
    "runtimeSessionId",
    "providerSessionId",
    "instanceId",
    "installationId",
    "kindId",
    "definitionSnapshotRef",
    "definitionSnapshot",
    "definitionSnapshotPersisted",
    "liveness",
    "attachCapability",
    "streamCursor",
    "associations",
    "activity",
    "installationState",
    "installationError",
    "semanticState",
    "attemptChain",
    "metrics",
    "context",
  ]);
  assert.ok(Object.keys(previous.session as JsonObject).every((key) => previousFields.has(key)));
  assert.doesNotThrow(() => parseDaemonGuiReadResponse("repo.agentRuntime.sessions.read", previous));
  await call("protocol.dispatchLifecycle.enable");
  const next = await call("repo.agentRuntime.sessions.read", params);
  assert.deepEqual((next.session as JsonObject).lifecycle, current.session.lifecycle);
  assert.doesNotThrow(() => parseDaemonGuiReadResponse("repo.agentRuntime.sessions.read", next));
  const { PassThrough, Writable } = await import("node:stream"),
    { JsonRpcLineClient } = await import("../src/client/local-json-rpc-client.ts"),
    input = new PassThrough();
  const sent: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      const request = JSON.parse(String(chunk));
      sent.push(request.method);
      void server.handle(request).then((response) => {
        input.write(`${JSON.stringify(response)}\n`);
        done();
      }, done);
    },
  });
  const client = new JsonRpcLineClient(input, output);
  try {
    await client.request("protocol.hello", daemonHelloParams());
    const result = await client.request("repo.agentRuntime.sessions.read", params);
    assert.deepEqual((result.session as JsonObject).lifecycle, current.session.lifecycle);
    assert.deepEqual(sent, ["protocol.hello", "protocol.dispatchLifecycle.enable", "repo.agentRuntime.sessions.read"]);
  } finally {
    client.close();
  }
  await call("protocol.hello", daemonHelloParams());
  assert.equal(((await call("repo.agentRuntime.sessions.read", params)).session as JsonObject).lifecycle, undefined);
});

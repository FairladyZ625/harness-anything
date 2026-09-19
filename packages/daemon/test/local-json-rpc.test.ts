// harness-test-tier: fast
import assert from "node:assert/strict";
import net from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import { actionDeclarations, getEntityKindContract } from "../../kernel/src/index.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { connectSocket, JsonRpcLineClient, requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import {
  actionForDaemonMethod,
  commandClassForAction,
  daemonGuiActionMethods,
  daemonProtocolCommands,
  parseDaemonRpcParams,
} from "../src/protocol/daemon-protocol.contract.ts";
import { isJsonObject, rejectSecretKeys } from "../src/protocol/json-rpc-types.ts";

// The `--wait` reader keeps one daemon connection alive for a whole wait and issues one read round
// per poll. The line client used to attach a fresh readline interface per request and abandon it at
// the matching response id, so on that reused connection data/end/error listeners stacked one set
// per round (the 11-listener incident) and every abandoned iterator kept parsing and retaining each
// later line — unbounded memory that degraded the waiting process until its own deadlines fired.
// The locks below pin the two properties the fix bought: listener counts stay flat across rounds on
// a reused connection, and round N still resolves with round N's response after a round whose
// deadline expired and whose late response came back on the same socket.
function lineServer(
  handler: (
    request: { readonly id: number; readonly method: string; readonly params: Record<string, unknown> },
    reply: (result: Record<string, unknown>) => void,
  ) => void,
): Promise<{ readonly socketPath: string; readonly close: () => Promise<void> }> {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-json-rpc-client-")),
    socketPath = localUserDaemonEndpoint(parent, "json-rpc-client");
  const server = net.createServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const request = JSON.parse(line) as { readonly id: number; readonly method: string };
        handler(request, (result) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`));
      }
    });
    socket.on("error", () => undefined);
  });
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () =>
      resolve({
        socketPath,
        close: async () => {
          await closeServer(server);
          rmSync(parent, { recursive: true, force: true });
        },
      }),
    );
  });
}

test("a reused connection keeps its socket listener counts flat across read rounds", async () => {
  const server = await lineServer((_request, reply) => reply({ ok: true }));
  const warnings: string[] = [],
    onWarning = (warning: Error) => warnings.push(warning.name);
  process.on("warning", onWarning);
  try {
    const socket = await connectSocket(server.socketPath, 2_000),
      client = new JsonRpcLineClient(socket, socket);
    try {
      await client.request("protocol.hello", { protocolVersion: { major: 1, minor: 0 } }, 5_000);
      const flat = {
        data: socket.listenerCount("data"),
        end: socket.listenerCount("end"),
        error: socket.listenerCount("error"),
      };
      assert.equal(
        flat.data >= 1 && flat.end >= 1 && flat.error >= 1,
        true,
        `hello must leave a reader attached: ${JSON.stringify(flat)}`,
      );
      for (let round = 1; round <= 150; round += 1) {
        const result = await client.request("repo.agentRuntime.sessions.read", { round }, 5_000);
        assert.deepEqual(result, { ok: true }, `round ${round} must resolve with its own response`);
        assert.deepEqual(
          {
            data: socket.listenerCount("data"),
            end: socket.listenerCount("end"),
            error: socket.listenerCount("error"),
          },
          flat,
          `listener counts must not grow with read rounds (after round ${round})`,
        );
      }
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.deepEqual(
        { data: socket.listenerCount("data"), end: socket.listenerCount("end"), error: socket.listenerCount("error") },
        { data: 0, end: flat.end - 1, error: flat.error - 2 },
        "close must detach the reader's listener set",
      );
    } finally {
      clientClose(client);
    }
  } finally {
    process.off("warning", onWarning);
    await server.close();
  }
  assert.equal(
    warnings.includes("MaxListenersExceededWarning"),
    false,
    `no listener ceiling may be crossed: ${warnings.join(", ")}`,
  );
});

test("a round whose deadline expired does not poison the next round on the same connection", async () => {
  const server = await lineServer((request, reply) =>
    setTimeout(() => reply({ ok: true, echo: request.method }), request.method === "stalled" ? 120 : 1),
  );
  try {
    const socket = await connectSocket(server.socketPath, 2_000),
      client = new JsonRpcLineClient(socket, socket);
    try {
      await client.request("protocol.hello", { protocolVersion: { major: 1, minor: 0 } }, 5_000);
      await assert.rejects(
        () => client.request("stalled", {}, 25),
        (error: unknown) => (error as { readonly code?: string }).code === "daemon_response_timeout",
      );
      await new Promise((resolve) => setTimeout(resolve, 200)); // the late response lands and must be dropped
      const next = await client.request("prompt", { round: 2 }, 5_000);
      assert.deepEqual(
        next,
        { ok: true, echo: "prompt" },
        "the next round must resolve with its own response, not the stale one",
      );
    } finally {
      clientClose(client);
    }
  } finally {
    await server.close();
  }
});

test("a daemon that closes mid-exchange rejects the pending request instead of hanging it", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-json-rpc-client-")),
    socketPath = localUserDaemonEndpoint(parent, "json-rpc-client-torn");
  const server = net.createServer((socket) => {
    let seenHello = false;
    socket.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const request = JSON.parse(line) as { readonly id: number; readonly method: string };
        if (request.method === "protocol.hello") {
          seenHello = true;
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`);
        } else if (seenHello) {
          // The first request after the handshake is torn down before any response is written.
          socket.destroy();
          return;
        }
      }
    });
    socket.on("error", () => undefined);
  });
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const socket = await connectSocket(socketPath, 2_000),
      client = new JsonRpcLineClient(socket, socket);
    try {
      await client.request("protocol.hello", { protocolVersion: { major: 1, minor: 0 } }, 5_000);
      await assert.rejects(
        () => client.request("repo.agentRuntime.sessions.read", {}, 5_000),
        /daemon closed before JSON-RPC response/u,
      );
      await assert.rejects(
        () => client.request("repo.agentRuntime.sessions.read", {}, 5_000),
        /daemon closed before JSON-RPC response/u,
      );
    } finally {
      clientClose(client);
    }
  } finally {
    await closeServer(server);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a socket write failure rejects the request as daemon unavailable", async () => {
  const input = new PassThrough(),
    failure = Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    output = new Writable({ write: (_chunk, _encoding, callback) => callback(failure) }),
    client = new JsonRpcLineClient(input, output);
  try {
    await assert.rejects(
      () => client.request("protocol.hello", { protocolVersion: { major: 1, minor: 0 } }, 5_000),
      (error: unknown) =>
        (error as { readonly code?: string }).code === "daemon_unavailable" &&
        (error as { readonly cause?: unknown }).cause === failure,
    );
  } finally {
    clientClose(client);
  }
});

function clientClose(client: { readonly close: () => void }): void {
  try {
    client.close();
  } catch {
    /* an already-torn socket may reject the final end */
  }
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

// Fragment from local-json-rpc-method-handshake.test.ts.
type Request = { readonly id: number; readonly method: string };

test("the handshake rejects a requested method absent from the daemon method table", async () => {
  const seen: string[] = [];
  const server = await rpcServer((request) => {
    seen.push(request.method);
    return request.method === "protocol.hello"
      ? { result: { ok: true, methods: ["protocol.hello"], build: { commit: "daemon-old" } } }
      : { result: { ok: true } };
  });
  try {
    await assert.rejects(requestDaemonJsonRpcAt(server.socketPath, "repo.gui.new-read", {}, 2_000), (error) => {
      assert.equal((error as { readonly code?: string }).code, "daemon_method_unavailable");
      assert.equal(
        (error as Error).message,
        "Attached local daemon build daemon-old does not advertise requested method repo.gui.new-read.",
      );
      return true;
    });
    assert.deepEqual(seen, ["protocol.hello"], "the unavailable method must not be sent after preflight");
  } finally {
    await server.close();
  }
});

test("daemon-only methods do not make the requested-method handshake fail", async () => {
  const server = await rpcServer((request) =>
    request.method === "protocol.hello"
      ? { result: { ok: true, methods: ["protocol.hello", "repo.gui.read", "daemon.extra"] } }
      : { result: { ok: true, value: "accepted" } },
  );
  try {
    assert.deepEqual(await requestDaemonJsonRpcAt(server.socketPath, "repo.gui.read", {}, 2_000), {
      ok: true,
      value: "accepted",
    });
  } finally {
    await server.close();
  }
});

test("a JSON-RPC method-not-found response retains its protocol identity", async () => {
  const server = await rpcServer((request) =>
    request.method === "protocol.hello"
      ? { result: { ok: true } }
      : { error: { code: -32601, message: "Method not found" } },
  );
  try {
    await assert.rejects(requestDaemonJsonRpcAt(server.socketPath, "repo.legacy", {}, 2_000), (error) => {
      assert.equal((error as { readonly code?: string }).code, "method_not_found");
      assert.equal((error as { readonly rpcCode?: number }).rpcCode, -32601);
      assert.equal((error as Error).message, "Method not found");
      return true;
    });
  } finally {
    await server.close();
  }
});

async function rpcServer(
  respond: (
    request: Request,
  ) =>
    | { readonly result: Record<string, unknown> }
    | { readonly error: { readonly code: number; readonly message: string } },
): Promise<{ readonly socketPath: string; readonly close: () => Promise<void> }> {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-method-handshake-")),
    socketPath = localUserDaemonEndpoint(parent, "method-handshake"),
    server = net.createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const request = JSON.parse(line) as Request;
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...respond(request) })}\n`);
        }
      });
    });
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

// Fragment from json-rpc-command-descriptors.test.ts.
test("non-read protocol, Policy, receipt, residency, and entity catalogs close over Action declarations", () => {
  const protocol = new Map(
      [...daemonProtocolCommands, ...daemonGuiActionMethods]
        .filter(({ commandClass }) => commandClass !== "repo-read")
        .map((descriptor) => [descriptor.actionKind ?? descriptor.id, descriptor]),
    ),
    declaredKinds = new Set(actionDeclarations.map(({ kind }) => kind)),
    protocolKinds = new Set(protocol.keys());
  assert.equal(actionDeclarations.length, 129);
  assert.deepEqual([...protocolKinds].sort(), [...declaredKinds].sort());
  for (const [kind, descriptor] of protocol) {
    const declaration = actionDeclarations.find((candidate) => candidate.kind === kind);
    assert.ok(declaration, kind);
    assert.equal(descriptor.commandClass, declaration.executionClass, kind);
    assert.deepEqual(Object.keys(declaration).sort(), [
      "catalogId",
      "executionClass",
      "kind",
      "policyAction",
      "receiptSettlement",
      "residency",
    ]);
  }

  const catalogActions = new Map(
    [
      ...new Set(actionDeclarations.flatMap(({ catalogId }) => (catalogId === null ? [] : [catalogId.split("/")[0]!]))),
    ].flatMap((kind) => {
      const contract = getEntityKindContract(kind);
      return (contract?.actionCatalog?.actions ?? []).map((action) => [`${kind}/${action.id}`, action] as const);
    }),
  );
  for (const declaration of actionDeclarations) {
    if (declaration.catalogId === null) continue;
    const action = catalogActions.get(declaration.catalogId);
    assert.ok(action?.execution, declaration.catalogId);
    assert.equal(action.execution.ingress, declaration.kind, declaration.catalogId);
    assert.equal(action.policy.action, declaration.policyAction, declaration.catalogId);
  }
  for (const kind of ["fact", "decision", "relation"])
    for (const action of getEntityKindContract(kind)?.actionCatalog?.actions ?? [])
      if (action.execution?.read === false) assert.notEqual(action.policy.action, null, `${kind}/${action.id}`);

  const localResidency = Object.fromEntries(
    actionDeclarations
      .filter(({ policyAction }) => policyAction === null)
      .map(({ kind, residency }) => [kind, residency.scope]),
  );
  assert.deepEqual(localResidency, {
    "agent-run": "runtime-local",
    "daemon-connection-add": "host-local",
    "daemon-connection-probe": "host-local",
    "daemon-connection-remove": "host-local",
    "daemon-connection-update": "host-local",
    "daemon-repo-update": "host-local",
  });
  for (const kind of ["ledger-backup", "ledger-restore-drill"]) {
    const declaration = actionDeclarations.find((candidate) => candidate.kind === kind);
    assert.equal(declaration?.residency.scope, "host-local", kind);
    assert.equal(declaration?.receiptSettlement, "none", kind);
  }
  assert.equal(
    actionDeclarations.find(({ kind }) => kind === "fact-record")?.receiptSettlement,
    "canonical-acceptance",
  );
  for (const kind of ["agent-run", "ci-observe-pull", "doc-materialize", "projection-rebuild"])
    assert.equal(actionDeclarations.find((candidate) => candidate.kind === kind)?.receiptSettlement, "none", kind);
});

test("protocol descriptors preserve topology metadata without authorizing actions", () => {
  const expected = {
    "migrate-import": "repo-write",
    "projection-rebuild": "repo-write",
    "task-create": "repo-write",
    "preset-list": "repo-read",
    "preset-inspect": "repo-read",
    "preset-check": "repo-read",
    "preset-validate": "repo-read",
    "preset-install": "repo-write",
    "preset-seed": "repo-write",
    "preset-audit": "repo-read",
    "preset-uninstall": "repo-write",
    "preset-upgrade": "repo-write",
    "script-run": "repo-write",
    "preset-run-start": "repo-write",
    "preset-run-status": "repo-read",
    "task-start": "repo-write",
    "task-progress-append": "repo-write",
    "task-artifact-add": "repo-write",
    "task-submit": "repo-write",
    "task-declare-executor": "repo-write",
    "task-review-execution": "arbiter",
    "task-review-consent": "repo-write",
    "task-code-doc-reconcile": "repo-write",
    "task-code-doc-repoint": "repo-write",
    "task-complete": "repo-write",
    "task-show": "repo-read",
    "receipt-show": "repo-read",
    "event-list": "repo-read",
    "event-show": "repo-read",
    "doc-status": "repo-read",
    "doc-dry-run": "repo-read",
    "doc-submit": "repo-write",
    "doc-materialize": "repo-write",
    "doc-show": "repo-read",
    "doc-retire": "repo-write",
    "fact-record": "repo-write",
    "fact-type-list": "repo-read",
    "fact-show": "repo-read",
    "decision-propose": "repo-write",
    "decision-validate": "repo-read",
    "decision-repin": "repo-write",
    "decision-transition": "repo-write",
    "decision-accept": "arbiter",
    "decision-reject": "arbiter",
    "decision-defer": "arbiter",
    "decision-retire": "repo-write",
    "decision-supersede": "repo-write",
    "decision-amend": "repo-write",
    "decision-claim-add": "repo-write",
    "decision-claim-fulfill": "repo-write",
    "relation-relate": "repo-write",
    "relation-reconfirm": "repo-write",
    "relation-unrelate": "repo-write",
    "decision-reckon": "repo-write",
    "decision-list": "repo-read",
    "decision-show": "repo-read",
    "distill-candidate": "repo-write",
    "distill-promote": "repo-write",
  } as const;
  assert.deepEqual(
    Object.fromEntries(Object.keys(expected).map((kind) => [kind, commandClassForAction(kind)])),
    expected,
  );
  for (const command of daemonProtocolCommands)
    if (command.commandClass === "repo-read") assert.notEqual(command.method, "repo.task.run", command.id);
  const legacyRead = { action: { kind: "task-show", taskId: "task-direct" } };
  assert.deepEqual(actionForDaemonMethod("repo.task.read", legacyRead), legacyRead.action);
  assert.throws(() => actionForDaemonMethod("repo.task.run", legacyRead), /closed method descriptor/u);
});

test("task-create and preset RPC descriptors enforce closed payloads and retire the open route", () => {
  const params = { repo: { repoId: "alpha" }, payload: { title: "Closed", presetId: "standard-task" } };
  assert.equal(parseDaemonRpcParams("repo.task.create", params).ok, true);
  assert.equal(
    parseDaemonRpcParams("repo.task.create", { ...params, payload: { ...params.payload, dryRun: true } }).ok,
    true,
  );
  assert.equal(
    parseDaemonRpcParams("repo.task.create", { ...params, payload: { ...params.payload, dryRun: "true" } }).ok,
    false,
  );
  assert.equal(
    parseDaemonRpcParams("repo.task.create", { ...params, payload: { ...params.payload, completionGateIds: [] } }).ok,
    false,
  );
  assert.deepEqual(actionForDaemonMethod("repo.task.create", params.payload), {
    kind: "task-create",
    ...params.payload,
  });
  assert.throws(
    () => actionForDaemonMethod("repo.task.run", { action: { kind: "task-create", title: "Open" } }),
    /closed method/u,
  );
  const fullPayload = {
    taskId: "task_full",
    title: "Full",
    idempotencyKey: "once",
    parentTaskId: "task_parent",
    workKind: "feat",
    riskTier: "high",
    urgency: "medium",
    moduleKey: "kernel",
    registerModule: { key: "kernel", title: "Kernel", prefix: "KER", scope: "packages/kernel/**" },
    surfaces: ["ha task create"],
    createMode: "admin",
  };
  assert.equal(parseDaemonRpcParams("repo.task.create", { repo: { repoId: "alpha" }, payload: fullPayload }).ok, true);
  const retiredBoolean = parseDaemonRpcParams("repo.task.create", {
    repo: { repoId: "alpha" },
    payload: { ...fullPayload, longRunning: true },
  });
  assert.equal(retiredBoolean.ok, false);
  if (!retiredBoolean.ok) {
    assert.equal(retiredBoolean.errors.length, 1);
    assert.match(
      retiredBoolean.errors[0]!,
      /params\.payload contains an unknown field "longRunning"; allowed fields:/u,
    );
    for (const field of ["taskId", "title", "taskClass", "idempotencyKey"])
      assert.match(retiredBoolean.errors[0]!, new RegExp(`"${field}"`, "u"));
  }
  assert.equal(
    parseDaemonRpcParams("repo.task.create", {
      repo: { repoId: "alpha" },
      payload: { ...fullPayload, taskClass: "long_running" },
    }).ok,
    true,
  );
});

// Fragment from json-rpc-secret-keys.test.ts.
test("secret-like keys are rejected at any depth while the JSON object check stays shallow", () => {
  assert.deepEqual(rejectSecretKeys({ note: "fine", nested: { detail: { apiKey: "x" } } }), [
    "payload contains a forbidden secret-like key",
  ]);
  assert.deepEqual(rejectSecretKeys({ items: [{ ok: 1 }, { token: "t" }] }), [
    "payload contains a forbidden secret-like key",
  ]);
  // String-valued token keys stay rejected under every spelling; no usage payload crosses this
  // surface, so the value-type line from the dispatch scrubber deliberately does not apply here.
  for (const key of ["token", "access_token", "id_token"])
    assert.deepEqual(rejectSecretKeys({ [key]: "opaque" }), ["payload contains a forbidden secret-like key"]);
  assert.deepEqual(rejectSecretKeys({ note: "token appears only in a value" }), []);
  assert.equal(isJsonObject({ nested: { anything: () => 1 } }), true);
  assert.equal(isJsonObject([]), false);
});

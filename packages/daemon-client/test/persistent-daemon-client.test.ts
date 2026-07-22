// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import type { DaemonClientDiagnostic } from "../../api-contracts/src/index.ts";
import { ConnectionPool } from "../src/connection-pool.ts";
import { JsonRpcWriter } from "../src/json-rpc-writer.ts";
import { PersistentDaemonClient } from "../src/persistent-daemon-client.ts";
import { createDaemonRegistryResolver } from "../src/registry-discovery.ts";
import { SshStdioTransport, sshStdioArgs } from "../src/ssh-stdio-transport.ts";
import { FakeConnection, FakeTransport, hello, receipt } from "./fake-transport.ts";

test("real command-receipt hello and projection notifications interleave with responses", async () => {
  const transport = subscribingTransport();
  const client = fixtureClient(transport);
  const events: string[] = [];
  client.onEvent((notification) => events.push(notification.event.entities[0]!.id));
  const helloResult = await client.connect();
  assert.equal(helloResult.capabilities.notifications, true);
  assert.deepEqual(helloResult.repos, [{ repoId: "repo-a", canonicalRoot: "/fixture" }]);
  await client.subscribe("repo-a");

  const request = client.request("protocol.hello", {
    protocolVersion: 1,
    clientName: "test",
    clientVersion: "1"
  });
  transport.connections[0]!.notify("repo-a", "task-1");
  await request;
  await waitFor(() => events.length === 1);
  assert.deepEqual(events, ["task-1"]);
  await client.dispose();
});

test("stale connection reconnects and restores repo subscriptions", async () => {
  const transport = subscribingTransport();
  const client = fixtureClient(transport, { reconnectBaseMs: 1 });
  const trace = [client.state()];
  client.onState((state) => trace.push(state));
  await client.subscribe("repo-a");
  transport.connections[0]!.disconnect();
  await waitFor(() => transport.connections.length === 2 && subscribeCount(transport) === 2);
  assert.deepEqual(trace, ["connecting", "live", "stale", "live"]);
  await client.dispose();
});

test("unknown and malformed notification frames leave diagnostic evidence", async () => {
  const diagnostics: DaemonClientDiagnostic[] = [];
  const transport = subscribingTransport();
  const client = fixtureClient(transport, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
  await client.subscribe("repo-a");
  transport.connections[0]!.emit({ jsonrpc: "2.0", method: "repo.event", params: {} });
  transport.connections[0]!.emit({ jsonrpc: "2.0", method: "repo.projection.changed", params: {} });
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), ["unknown_notification", "invalid_notification"]);
  await client.dispose();
});

test("subscription rejection and timeout are diagnostic and reject for polling fallback", async () => {
  const diagnostics: DaemonClientDiagnostic[] = [];
  const unavailable = new FakeTransport((request, connection) => {
    if (hello(connection, request)) return;
    if (request.method === "repo.notifications.subscribe") {
      connection.respond(request.id, {
        ok: false,
        schema: "command-receipt/v2",
        command: request.method,
        summary: "not configured",
        error: { code: "notifications_unavailable", hint: "not configured" }
      });
    }
  });
  const rejected = fixtureClient(unavailable, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
  await assert.rejects(rejected.subscribe("repo-a"), /notifications_unavailable/u);
  assert.equal(diagnostics.at(-1)?.code, "subscription_failed");
  await rejected.dispose();

  const timeout = new FakeTransport((request, connection) => { hello(connection, request); });
  const timedOut = fixtureClient(timeout, { requestTimeoutMs: 5, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
  await assert.rejects(timedOut.subscribe("repo-a"), /timed out/u);
  assert.match(diagnostics.at(-1)?.message ?? "", /timed out/u);
  await timedOut.dispose();
});

test("abort, disconnect and dispose reject pending hello deterministically", async () => {
  const transport = new FakeTransport(() => undefined);
  const client = fixtureClient(transport, { requestTimeoutMs: 100 });
  const controller = new AbortController();
  const aborted = client.connect(controller.signal);
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  await client.dispose();

  const disconnectedTransport = new FakeTransport(() => undefined);
  const disconnectedClient = fixtureClient(disconnectedTransport);
  const disconnected = disconnectedClient.connect();
  await waitFor(() => disconnectedTransport.connections.length === 1);
  disconnectedTransport.connections[0]!.disconnect(new Error("fixture disconnect"));
  await assert.rejects(disconnected, /fixture disconnect/u);
  await disconnectedClient.dispose();
});

test("connection pool separates endpoint sockets from repo subscriptions", async () => {
  const created: PersistentDaemonClient[] = [];
  const transports: FakeTransport[] = [];
  const pool = new ConnectionPool((endpoint) => {
    const transport = subscribingTransport();
    transports.push(transport);
    const client = fixtureClient(transport, { endpoint });
    created.push(client);
    return client;
  });
  const a = await pool.acquire("unix:/daemon", "repo-a");
  const b = await pool.acquire("unix:/daemon", "repo-b");
  const a2 = await pool.acquire("unix:/daemon", "repo-a");
  assert.equal(created.length, 1);
  assert.equal(transports[0]!.connections.length, 1);
  assert.deepEqual(pool.snapshot(), [{ endpoint: "unix:/daemon", repos: ["repo-a", "repo-b"] }]);
  await a.dispose();
  await a2.dispose();
  await b.dispose();
  assert.deepEqual(pool.snapshot(), []);
});

test("positive controls detect unknown response ids and invalid state traces", () => {
  const connection = new FakeConnection(() => undefined);
  const writer = new JsonRpcWriter(connection);
  assert.throws(() => writer.accept({ jsonrpc: "2.0", id: 999, result: {} }), /unknown daemon response id/u);
  assert.throws(() => assertValidTrace(["connecting", "live", "unknown", "stale"]), /invalid state transition/u);
});

test("registry discovery returns endpoint plus repoId and fails closed on unknown roots", () => {
  const known = createDaemonRegistryResolver({
    endpoint: "unix:/daemon",
    userRoot: "/profile",
    resolveRepoByRoot: (() => ({ repoId: "repo-a", state: "enabled" })) as never
  });
  const unknown = createDaemonRegistryResolver({
    endpoint: "unix:/daemon",
    userRoot: "/profile",
    resolveRepoByRoot: (() => { throw new Error("unknown root"); }) as never
  });
  assert.deepEqual(known("/work/a"), { endpoint: "unix:/daemon", repoId: "repo-a" });
  assert.equal(unknown("/work/missing"), undefined);
});

test("registry discovery fails explicitly when the kernel resolver seam is not injected", () => {
  assert.throws(
    () => createDaemonRegistryResolver({ endpoint: "unix:/daemon", userRoot: "/profile" } as never),
    /requires resolveRepoByRoot after PLT-Boundary W1/u
  );
});

test("ssh stdio transport uses the CLI command shape and carries JSON-RPC lines", async () => {
  const calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  const transport = new SshStdioTransport({
    host: "remote-alias",
    remoteHaPath: "/opt/ha",
    spawnProcess: (command, args, options) => {
      calls.push({ command, args });
      return spawn(process.execPath, ["-e", [
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        "process.stdin.on('data', chunk => {",
        "  buffer += chunk;",
        "  const newline = buffer.indexOf('\\n');",
        "  if (newline < 0) return;",
        "  const request = JSON.parse(buffer.slice(0, newline));",
        "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { echoed: request.method } }) + '\\n');",
        "});"
      ].join("\n")], options);
    }
  });
  const connection = await transport.open("ssh-stdio:remote-alias");
  const response = new Promise<unknown>((resolve) => connection.onFrame(resolve));
  connection.write({ jsonrpc: "2.0", id: 7, method: "repo.tasks.list", params: {} });

  assert.deepEqual(await response, { jsonrpc: "2.0", id: 7, result: { echoed: "repo.tasks.list" } });
  assert.deepEqual(calls, [{ command: "ssh", args: sshStdioArgs("remote-alias", "/opt/ha") }]);
  await connection.close();
});

function fixtureClient(
  transport: FakeTransport,
  overrides: Partial<ConstructorParameters<typeof PersistentDaemonClient>[0]> = {}
): PersistentDaemonClient {
  return new PersistentDaemonClient({
    endpoint: "unix:/fixture",
    transport,
    requestTimeoutMs: 100,
    reconnectBaseMs: 2,
    reconnectMaxMs: 5,
    jitter: () => 0,
    onDiagnostic: () => undefined,
    ...overrides
  });
}

function subscribingTransport(): FakeTransport {
  return new FakeTransport((request, connection) => {
    if (hello(connection, request)) return;
    if (request.method === "repo.notifications.subscribe" || request.method === "repo.notifications.unsubscribe") {
      connection.respond(request.id, receipt(request.method, { subscription: "projection-change/v1" }));
    }
  });
}

function subscribeCount(transport: FakeTransport): number {
  return transport.connections.flatMap((connection) => connection.writes)
    .filter((frame) => (frame as { method?: string }).method === "repo.notifications.subscribe").length;
}

function assertValidTrace(trace: readonly string[]): void {
  const allowed = new Set(["connecting>live", "live>stale", "stale>live"]);
  for (let index = 1; index < trace.length; index += 1) {
    if (!allowed.has(`${trace[index - 1]}>${trace[index]}`)) throw new Error("invalid state transition");
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture wait timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

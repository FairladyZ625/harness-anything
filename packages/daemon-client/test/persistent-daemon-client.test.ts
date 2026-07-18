// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { ConnectionPool } from "../src/connection-pool.ts";
import { JsonRpcWriter } from "../src/json-rpc-writer.ts";
import { PersistentDaemonClient } from "../src/persistent-daemon-client.ts";
import { createDaemonRegistryResolver } from "../src/registry-discovery.ts";
import { FakeConnection, FakeTransport, hello, type RequestFrame } from "./fake-transport.ts";

test("20 concurrent responses and interleaved notifications keep ids and frames", async () => {
  const queued: Array<{ request: RequestFrame; connection: FakeConnection }> = [];
  const transport = new FakeTransport((request, connection) => {
    if (hello(connection, request)) return;
    if (request.method === "repo.notifications.subscribe") {
      connection.respond(request.id, { subscribed: true, headSeq: 0 });
      return;
    }
    queued.push({ request, connection });
  });
  const client = fixtureClient(transport, async () => ({ headSeq: 0 }));
  const events: number[] = [];
  client.onEvent((event) => events.push(event.seq));
  await client.subscribe("repo-a");
  const requests = Array.from({ length: 20 }, (_, index) => client.request("repo.read-full", { repoId: `repo-${index}` }));
  await waitFor(() => queued.length === 20);
  queued.slice().reverse().forEach(({ request, connection }, index) => {
    connection.notify("repo-a", index + 1);
    connection.respond(request.id, { headSeq: Number((request.params as { repoId: string }).repoId.slice(5)) });
  });
  const results = await Promise.all(requests);
  await waitFor(() => events.length === 20);
  assert.deepEqual(results.map((result) => result.headSeq), Array.from({ length: 20 }, (_, index) => index));
  assert.deepEqual(events, Array.from({ length: 20 }, (_, index) => index + 1));
  await client.dispose();
});

test("state traces cover stale reconnect and retention gap full-read", async () => {
  let subscribeCalls = 0;
  let fullReads = 0;
  const transport = new FakeTransport((request, connection) => {
    if (hello(connection, request)) return;
    if (request.method === "repo.notifications.subscribe") {
      subscribeCalls += 1;
      if (subscribeCalls === 2) connection.reject(request.id, "RETENTION_GAP", { code: "RETENTION_GAP" });
      else connection.respond(request.id, { subscribed: true, headSeq: fullReads });
    } else if (request.method === "repo.notifications.unsubscribe") {
      connection.respond(request.id, { unsubscribed: true });
    }
  });
  const client = fixtureClient(transport, async () => ({ headSeq: ++fullReads }), { reconnectBaseMs: 1 });
  const trace = [client.state()];
  client.onState((state) => trace.push(state));
  await client.subscribe("repo-a");
  transport.connections[0]!.disconnect();
  await waitFor(() => transport.connections.length === 2 && client.state() === "live");
  assert.deepEqual(trace, ["connecting", "live", "stale", "unknown", "live"]);
  assert.equal(fullReads, 2);
  await client.dispose();
});

test("catch-up reconnect follows connecting to live to stale to live", async () => {
  const transport = subscribingTransport();
  const client = fixtureClient(transport, async () => ({ headSeq: 0 }), { reconnectBaseMs: 1 });
  const trace = [client.state()];
  client.onState((state) => trace.push(state));
  await client.subscribe("repo-a");
  transport.connections[0]!.disconnect();
  await waitFor(() => transport.connections.length === 2 && client.state() === "live");
  assert.deepEqual(trace, ["connecting", "live", "stale", "live"]);
  await client.dispose();
});

test("sequence gap exposes unknown until full-read completes", async () => {
  let releaseRead: (() => void) | undefined;
  let reads = 0;
  const transport = subscribingTransport();
  const client = fixtureClient(transport, async () => {
    reads += 1;
    if (reads > 1) await new Promise<void>((resolve) => { releaseRead = resolve; });
    return { headSeq: reads === 1 ? 1 : 3 };
  });
  await client.subscribe("repo-a");
  transport.connections[0]!.notify("repo-a", 3);
  await waitFor(() => client.state() === "unknown");
  assert.equal(client.state(), "unknown");
  releaseRead?.();
  await waitFor(() => client.state() === "live");
  assert.equal(reads, 2);
  await client.dispose();
});

test("missing notification capability degrades to full-read polling", async () => {
  let reads = 0;
  const transport = new FakeTransport((request, connection) => { hello(connection, request, false); });
  const client = fixtureClient(transport, async () => ({ headSeq: ++reads }), { pollIntervalMs: 2 });
  await client.subscribe("repo-a");
  await waitFor(() => reads >= 2);
  assert.equal(client.state(), "live");
  assert.equal(transport.connections[0]!.writes.some((frame) => JSON.stringify(frame).includes("notifications.subscribe")), false);
  await client.dispose();
});

test("timeout, abort, disconnect and dispose reject pending work deterministically", async () => {
  const transport = new FakeTransport((request, connection) => { hello(connection, request); });
  const client = fixtureClient(transport, async () => ({ headSeq: 0 }), { requestTimeoutMs: 5 });
  await client.connect();
  await assert.rejects(client.request("repo.read-full", { repoId: "timeout" }), /timed out/u);
  const controller = new AbortController();
  const aborted = client.request("repo.read-full", { repoId: "abort" }, controller.signal);
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  const disconnected = client.request("repo.read-full", { repoId: "disconnect" });
  await waitFor(() => transport.connections[0]!.writes.some((frame) => JSON.stringify(frame).includes("disconnect")));
  transport.connections[0]!.disconnect(new Error("fixture disconnect"));
  await assert.rejects(disconnected, /fixture disconnect/u);
  const started = Date.now();
  await client.dispose();
  assert.ok(Date.now() - started < 1_000);
  assert.equal(transport.connections.flatMap((connection) => connection.writes).some((frame) => JSON.stringify(frame).includes("terminate")), false);
});

test("connection pool separates endpoint sockets from repo subscriptions", async () => {
  const created: PersistentDaemonClient[] = [];
  const transports: FakeTransport[] = [];
  const pool = new ConnectionPool((endpoint) => {
    const transport = subscribingTransport();
    transports.push(transport);
    const client = fixtureClient(transport, async () => ({ headSeq: 0 }), { endpoint });
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
  assert.deepEqual(pool.snapshot()[0]?.repos, ["repo-a", "repo-b"]);
  await a2.dispose();
  assert.deepEqual(pool.snapshot()[0]?.repos, ["repo-b"]);
  await b.dispose();
  assert.deepEqual(pool.snapshot(), []);
});

test("positive controls detect unknown response ids and invalid state traces", async () => {
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

function fixtureClient(
  transport: FakeTransport,
  readFull: (repoId: string) => Promise<{ headSeq: number }>,
  overrides: Partial<ConstructorParameters<typeof PersistentDaemonClient>[0]> = {}
): PersistentDaemonClient {
  return new PersistentDaemonClient({
    endpoint: "unix:/fixture",
    transport,
    readFull,
    requestTimeoutMs: 100,
    reconnectBaseMs: 2,
    reconnectMaxMs: 5,
    jitter: () => 0,
    ...overrides
  });
}

function subscribingTransport(): FakeTransport {
  return new FakeTransport((request, connection) => {
    if (hello(connection, request)) return;
    if (request.method === "repo.notifications.subscribe") connection.respond(request.id, { subscribed: true, headSeq: 1 });
    if (request.method === "repo.notifications.unsubscribe") connection.respond(request.id, { unsubscribed: true });
  });
}

function assertValidTrace(trace: readonly string[]): void {
  const allowed = new Set(["connecting>live", "live>stale", "stale>connecting", "live>unknown", "unknown>live"]);
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

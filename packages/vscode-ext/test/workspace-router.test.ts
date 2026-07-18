// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type * as vscode from "vscode";
import { ConnectionPool } from "../../daemon-client/src/connection-pool.ts";
import { PersistentDaemonClient } from "../../daemon-client/src/persistent-daemon-client.ts";
import { FakeTransport, hello } from "../../daemon-client/test/fake-transport.ts";
import { WorkspaceRouter } from "../src/routing/workspace-router.ts";

test("unknown roots fail closed with an explicit action and zero transport requests", async () => {
  let clients = 0;
  const notices: string[] = [];
  const pool = new ConnectionPool(() => {
    clients += 1;
    return client(new FakeTransport(() => undefined));
  });
  const router = new WorkspaceRouter({
    pool,
    resolveFolder: async () => undefined,
    onUnknownRoot: ({ action }) => notices.push(action)
  });
  await router.reconcile([folder("unknown", "/unknown")]);
  assert.equal(router.route(uri("/unknown/file.ts")), undefined);
  assert.equal(router.connection(uri("/unknown/file.ts")), undefined);
  assert.equal(clients, 0);
  assert.deepEqual(notices, ["Register workspace folder with Harness"]);
  await router.dispose();
});

test("RepoKey includes endpoint and repoId while endpoint sockets and repo subscriptions stay separate", async () => {
  const transports: FakeTransport[] = [];
  const pool = new ConnectionPool((endpoint) => {
    const transport = daemonTransport();
    transports.push(transport);
    return client(transport, endpoint);
  });
  const routes = new Map([
    ["a", { endpoint: "unix:/shared", repoId: "repo-a" }],
    ["b", { endpoint: "unix:/shared", repoId: "repo-b" }],
    ["c", { endpoint: "tcp://127.0.0.1:9000", repoId: "repo-c" }]
  ]);
  const router = new WorkspaceRouter({
    pool,
    resolveFolder: async (workspace) => routes.get(workspace.name),
    onUnknownRoot: () => assert.fail("known root reported unknown")
  });
  const a = folder("a", "/work/a");
  const b = folder("b", "/work/b");
  const c = folder("c", "/work/c");
  await router.reconcile([a, b, c]);
  assert.deepEqual(router.route(uri("/work/a/src/a.ts")), { endpoint: "unix:/shared", repoId: "repo-a" });
  assert.deepEqual(router.route(uri("/work/b/src/b.ts")), { endpoint: "unix:/shared", repoId: "repo-b" });
  assert.equal(transports.length, 2);
  assert.deepEqual(pool.snapshot(), [
    { endpoint: "unix:/shared", repos: ["repo-a", "repo-b"] },
    { endpoint: "tcp://127.0.0.1:9000", repos: ["repo-c"] }
  ]);
  await router.reconcile([b, c]);
  assert.deepEqual(pool.snapshot()[0]?.repos, ["repo-b"]);
  assert.equal(transports[0]?.connections[0]?.closed, false);
  await router.reconcile([c]);
  assert.equal(transports[0]?.connections[0]?.closed, true);
  await router.dispose();
});

test("longest workspace root wins without first-root fallback", async () => {
  const pool = new ConnectionPool((endpoint) => client(daemonTransport(), endpoint));
  const router = new WorkspaceRouter({
    pool,
    resolveFolder: async (workspace) => ({ endpoint: "unix:/shared", repoId: workspace.name }),
    onUnknownRoot: () => undefined
  });
  await router.reconcile([folder("outer", "/work"), folder("inner", "/work/nested")]);
  assert.equal(router.route(uri("/work/nested/file.ts"))?.repoId, "inner");
  assert.equal(router.route(uri("/elsewhere/file.ts")), undefined);
  await router.dispose();
});

test("positive controls detect an extra socket, wrong RepoKey and injected unknown request", () => {
  assert.throws(() => assertRoutingReceipt({ sockets: 2, repo: { endpoint: "unix:/shared", repoId: "wrong" }, unknownRequests: 1 }), /socket count|RepoKey|unknown root/u);
  assert.doesNotThrow(() => assertRoutingReceipt({ sockets: 1, repo: { endpoint: "unix:/shared", repoId: "repo-a" }, unknownRequests: 0 }));
});

function client(transport: FakeTransport, endpoint = "unix:/fixture"): PersistentDaemonClient {
  return new PersistentDaemonClient({ endpoint, transport, readFull: async () => ({ headSeq: 0 }), requestTimeoutMs: 100 });
}

function daemonTransport(): FakeTransport {
  return new FakeTransport((request, connection) => {
    if (hello(connection, request)) return;
    if (request.method === "repo.notifications.subscribe") connection.respond(request.id, { subscribed: true, headSeq: 0 });
    if (request.method === "repo.notifications.unsubscribe") connection.respond(request.id, { unsubscribed: true });
  });
}

function uri(path: string): vscode.Uri {
  return { scheme: "file", authority: "", path, fsPath: path, query: "", fragment: "", toString: () => `file://${path}` } as vscode.Uri;
}

function folder(name: string, path: string): vscode.WorkspaceFolder {
  return { name, index: 0, uri: uri(path) };
}

function assertRoutingReceipt(input: { sockets: number; repo: { endpoint: string; repoId: string }; unknownRequests: number }): void {
  if (input.sockets !== 1) throw new Error("socket count mismatch");
  if (input.repo.endpoint !== "unix:/shared" || input.repo.repoId !== "repo-a") throw new Error("RepoKey mismatch");
  if (input.unknownRequests !== 0) throw new Error("unknown root emitted a request");
}

// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { openRepoCell } from "../src/repo-cell.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;

test("RepoCell serializes identical lifecycle intents into one Git publication and one applied receipt", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId: workspaceId("alpha"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" });
    const action = { kind: "task-create", verb: "create", commandType: "CreateReplayTask", taskId: "task-alpha",
      title: "Alpha task", completionGateIds: [] } as const;

    const [left, right] = await Promise.all([
      cell.run(action, { actor, source: "local" }),
      cell.run(action, { actor, source: "local" })
    ]);

    assert.deepEqual([left.outcome, right.outcome], ["applied", "applied"], JSON.stringify([left, right]));
    assert.equal(left.opId, right.opId);
    assert.equal(left.revision, 1);
    assert.equal(git(rootDir, "rev-list", "--count", "HEAD"), "2");
    const shown = await cell.run({ kind: "task-show", verb: "show", taskId: "task-alpha" }, { actor, source: "local" });
    assert.equal(shown.outcome, "applied");
    assert.match(String(shown.evidence), /Alpha task/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const killpoint of ["before_event_write", "after_event_write", "after_head_write", "after_git_commit",
  "after_sqlite_commit", "before_response_write", "after_response_write"] as const) {
  test(`RepoCell new generation recovers ${killpoint} without a duplicate publication`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-crash-"));
    const action = { kind: "task-create", taskId: `task-${killpoint}`, title: killpoint, completionGateIds: [] } as const;
    let crashed: Awaited<ReturnType<typeof openRepoCell>> | undefined, recovered: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initRepo(rootDir); crashed = await openRepoCell({ repoId: workspaceId("crash"), rootDir: canonicalRoot(rootDir), ownerId: "generation-one",
        killpoint: (point) => { if (point === killpoint) throw new Error(`crash:${point}`); } });
      const first = await crashed.run(action, { actor, source: "local" });
      assert.equal(first.outcome, "rejected"); assert.equal(crashed.status().state, "unavailable");
      await crashed.close(); crashed = undefined;
      recovered = await openRepoCell({ repoId: workspaceId("crash"), rootDir: canonicalRoot(rootDir), ownerId: "generation-two" });
      const retried = await recovered.run(action, { actor, source: "local" });
      assert.equal(retried.outcome, "applied", JSON.stringify(retried));
      assert.equal(git(rootDir, "rev-list", "--count", "HEAD"), "2");
    } finally { await crashed?.close(); await recovered?.close(); rmSync(rootDir, { recursive: true, force: true }); }
  });
}

test("bootstrap concurrent writer admission commits one complete workspace", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-writer-")), rootDir = path.join(parent, "repo");
  const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0,
    source: "unix-socket-filesystem-owner-boundary" } } as const;
  const hosts = await Promise.all(["one", "two"].map((daemonId) => openDaemonHost({ daemonId, userRoot: path.join(parent, daemonId) })));
  try { const results = await Promise.allSettled(hosts.map((host) => host.bootstrap({ rootDir, repoId: "fresh", personId: "owner", displayName: "Owner" }, auth)));
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1); assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    assert.equal(git(rootDir, "rev-list", "--count", "HEAD"), "1"); assert.equal(git(rootDir, "status", "--porcelain"), ""); }
  finally { await Promise.all(hosts.map((host) => host.close())); rmSync(parent, { recursive: true, force: true }); }
});

test("unrelated workspace lock collision does not block either workspace", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-lock-collision-")), owners = new Map<number, string>(); let roots: string[] | undefined;
  for (let index = 0; index < 1_000 && !roots; index += 1) { const root = path.join(parent, `repo-${index}`), port = 40_000 + Number.parseInt(createHash("sha256").update(root).digest("hex").slice(0, 4), 16) % 20_000;
    const prior = owners.get(port); if (prior) roots = [prior, root]; else owners.set(port, root); }
  assert.ok(roots, "fixture must find roots that collide under the retired 16-bit TCP-port lock");
  roots.forEach((root) => { mkdirSync(root); initRepo(root); }); const cells = await Promise.all(roots.map((rootDir, index) => openRepoCell({ repoId: workspaceId(`repo-${index}`),
    rootDir: canonicalRoot(rootDir), ownerId: `daemon-${index}` })));
  try { assert.deepEqual(cells.map((cell) => cell.status().state), ["attached", "attached"]); }
  finally { await Promise.all(cells.map((cell) => cell.close())); rmSync(parent, { recursive: true, force: true }); }
});

test("JSON-RPC failure receipt carries formal operation identity and origin", async () => {
  const host = { run: async () => { throw new Error("unused"); }, bootstrap: async () => ({}), admin: async () => ({}),
    status: () => ({ daemonId: "test", pid: process.pid, repos: [] }), close: async () => undefined };
  const server = createJsonRpcProtocolServer({ host, authContext: { transportKind: "unix-socket" } });
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: -1 } });
  assert.ok(response && !Array.isArray(response) && "result" in response); if (response && !Array.isArray(response) && "result" in response) {
    const receipt = response.result as Record<string, unknown>; assert.equal(receipt.outcome, "rejected"); assert.equal(receipt.opId, "N/A"); assert.equal(receipt.origin, "daemon"); }
  await server.handle({ jsonrpc: "2.0", id: 2, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } });
  const malformed = await server.handle({ jsonrpc: "2.0", id: 3, method: "daemon.status", params: "not-an-object" });
  assert.ok(malformed && !Array.isArray(malformed) && "result" in malformed); if (malformed && !Array.isArray(malformed) && "result" in malformed) assert.equal((malformed.result as Record<string, unknown>).code, "invalid_request");
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

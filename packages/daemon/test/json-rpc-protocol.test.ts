// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { openRepoCell } from "../src/repo-cell.ts";
const DOC_POLICY_ID = "markdown-additive/v1";

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
    assert.equal(git(rootDir, "rev-list", "--count", "refs/ha/canonical"), "2");
    const shown = await cell.run({ kind: "task-show", verb: "show", taskId: "task-alpha" }, { actor, source: "local" });
    assert.equal(shown.outcome, "applied");
    assert.match(String(shown.evidence), /Alpha task/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("receipt lookup reports Git object-store failure as indeterminate and marks the RepoCell unavailable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-corrupt-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("corrupt"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" });
    const applied = await cell.run({ kind: "task-create", taskId: "task-corrupt", title: "Corrupt", completionGateIds: [] }, { actor, source: "local" }); assert.equal(applied.outcome, "applied");
    rmSync(path.join(rootDir, ".git/objects"), { recursive: true, force: true });
    const receipt = await cell.run({ kind: "receipt-show", opId: applied.opId }, { actor, source: "local" });
    assert.deepEqual({ outcome: receipt.outcome, code: receipt.code, origin: receipt.origin }, { outcome: "indeterminate", code: "vcs_command_failed", origin: "git" });
    assert.match(receipt.nextAction ?? "", /repair.*object.*retry/iu); assert.equal(cell.status().state, "unavailable");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
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
      assert.equal(git(rootDir, "rev-list", "--count", "refs/ha/canonical"), "2");
    } finally { await crashed?.close(); await recovered?.close(); rmSync(rootDir, { recursive: true, force: true }); }
  });
}

test("RepoCell doc mapping enforces strict dual CAS, holder receipts, deletion rejection, and worktree preservation", async (context) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-cell-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("docs"), rootDir: canonicalRoot(rootDir), ownerId: "doc-daemon" });
    assert.equal((await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs", completionGateIds: [] }, { actor, source: "local" })).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-start", taskId: "task-doc", executionId: "execution-doc" }, { actor, source: "local" })).outcome, "applied");
    const claims = path.join(rootDir, ".harness/doc-sync-claims"), authored = path.join(rootDir, "harness/context/notes.md"); mkdirSync(claims, { recursive: true }); mkdirSync(path.dirname(authored), { recursive: true });
    let body = "# Notes\nA\n", hash = createHash("sha256").update(body).digest("hex"), base = git(rootDir, "rev-parse", "refs/ha/canonical"); writeFileSync(authored, body); writeFileSync(path.join(claims, "one"), body);
    const statusBefore = await cell.run({ kind: "doc-status", paths: ["context/notes.md"] }, { actor, source: "local" }); assert.equal(statusBefore.outcome, "applied"); assert.equal(statusBefore.proof?.worktreeVisible, null);
    const action = { kind: "doc-submit", executionId: "execution-doc", baseLedgerSha: base, changes: [{ path: "context/notes.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { ref: "doc-sync-claims/one", sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" } }] } as const;
    const before = { head: git(rootDir, "rev-parse", "HEAD"), status: git(rootDir, "status", "--porcelain", "-uall"), bytes: readFileSync(authored).toString("hex") }, applied = await cell.run(action, { actor, source: "local" });
    assert.equal(applied.outcome, "applied", JSON.stringify(applied)); assert.equal(applied.detail?.kind, "doc_sync"); assert.equal(applied.proof?.worktreeVisible, true); assert.deepEqual({ head: git(rootDir, "rev-parse", "HEAD"), status: git(rootDir, "status", "--porcelain", "-uall"), bytes: readFileSync(authored).toString("hex") }, before);
    const shown = await cell.run({ kind: "receipt-show", opId: applied.opId }, { actor, source: "local" }); assert.equal(shown.outcome, "applied"); assert.equal(shown.detail?.kind, "doc_sync"); assert.equal(shown.proof?.canonicalVisible, true);
    const commits = git(rootDir, "rev-list", "--count", "refs/ha/canonical"); assert.deepEqual(await cell.run(action, { actor, source: "local" }), applied); assert.equal(git(rootDir, "rev-list", "--count", "refs/ha/canonical"), commits);
    const next = `${body}B\n`, nextHash = createHash("sha256").update(next).digest("hex"); writeFileSync(path.join(claims, "two"), next);
    const staleLedger = await cell.run({ ...action, baseLedgerSha: base, changes: [{ ...action.changes[0], baseBlobSha256: hash, candidate: { ...action.changes[0].candidate, ref: "doc-sync-claims/two", sha256: nextHash, size: Buffer.byteLength(next) } }] }, { actor, source: "local" });
    assert.equal(staleLedger.code, "base_ledger_changed"); assert.equal(staleLedger.detail?.holder?.executionId, "execution-doc");
    base = git(rootDir, "rev-parse", "refs/ha/canonical"); const staleBlob = await cell.run({ ...action, baseLedgerSha: base, changes: [{ ...action.changes[0], baseBlobSha256: "f".repeat(64), candidate: { ...action.changes[0].candidate, ref: "doc-sync-claims/two", sha256: nextHash, size: Buffer.byteLength(next) } }] }, { actor, source: "local" });
    assert.equal(staleBlob.code, "base_blob_changed"); assert.equal(staleBlob.detail?.holder?.personId, "person-owner");
    const deletion = await cell.run({ kind: "doc-submit", executionId: "execution-doc", baseLedgerSha: base, changes: [{ path: "context/notes.md", baseBlobSha256: hash, policyId: DOC_POLICY_ID, candidate: null }] }, { actor, source: "local" }); assert.equal(deletion.code, "deletion_forbidden");
    const beforeBatch = git(rootDir, "rev-parse", "refs/ha/canonical"), partial = await cell.run({ ...action, baseLedgerSha: base, changes: [{ ...action.changes[0], baseBlobSha256: hash, candidate: { ...action.changes[0].candidate, ref: "doc-sync-claims/two", sha256: nextHash, size: Buffer.byteLength(next) } }, { path: "context/missing.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { ref: "doc-sync-claims/missing", sha256: "e".repeat(64), size: 1, mediaType: "text/markdown" } }] }, { actor, source: "local" }); assert.equal(partial.code, "content_claim_mismatch"); assert.equal(git(rootDir, "rev-parse", "refs/ha/canonical"), beforeBatch);
    const samples: number[] = []; for (let index = 0; index < 7; index += 1) { const candidate = `${body}${Array.from({ length: index + 1 }, (_, n) => `line-${n}\n`).join("")}`, candidateHash = createHash("sha256").update(candidate).digest("hex"), ref = `doc-sync-claims/perf-${index}`; writeFileSync(authored, candidate); writeFileSync(path.join(rootDir, ".harness", ref), candidate); const started = performance.now(), result = await cell.run({ kind: "doc-submit", executionId: "execution-doc", baseLedgerSha: git(rootDir, "rev-parse", "refs/ha/canonical"), changes: [{ path: "context/notes.md", baseBlobSha256: hash, policyId: DOC_POLICY_ID, candidate: { ref, sha256: candidateHash, size: Buffer.byteLength(candidate), mediaType: "text/markdown" } }] }, { actor, source: "local" }); samples.push(performance.now() - started); assert.equal(result.outcome, "applied", JSON.stringify(result)); body = candidate; hash = candidateHash; }
    samples.sort((a, b) => a - b); const p50 = samples[Math.floor(samples.length / 2)]!; context.diagnostic(`doc-single-write-p50=${p50.toFixed(3)}ms samples=${samples.map((sample) => sample.toFixed(3)).join(",")}`); assert.equal(p50 < 500, true, `doc write p50 ${p50}ms`);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("doc ingress rejects symbolic links in claim and authored path chains", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-claim-link-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("claim-link"), rootDir: canonicalRoot(rootDir), ownerId: "doc-daemon" });
    await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs", completionGateIds: [] }, { actor, source: "local" }); await cell.run({ kind: "task-start", taskId: "task-doc", executionId: "execution-doc" }, { actor, source: "local" });
    const body = "# Outside\n", hash = createHash("sha256").update(body).digest("hex"), claims = path.join(rootDir, ".harness/doc-sync-claims"); mkdirSync(claims, { recursive: true }); writeFileSync(path.join(rootDir, "outside.md"), body); symlinkSync("../../outside.md", path.join(claims, "linked"));
    const base = git(rootDir, "rev-parse", "refs/ha/canonical"), result = await cell.run({ kind: "doc-submit", executionId: "execution-doc", baseLedgerSha: base, changes: [{ path: "context/link.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { ref: "doc-sync-claims/linked", sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" } }] }, { actor, source: "local" });
    assert.equal(result.code, "content_claim_mismatch"); assert.equal(git(rootDir, "rev-parse", "refs/ha/canonical"), base);
    writeFileSync(path.join(claims, "plain"), body); mkdirSync(path.join(rootDir, "harness/context"), { recursive: true }); symlinkSync("../../outside.md", path.join(rootDir, "harness/context/link.md"));
    const authoredLink = await cell.run({ kind: "doc-submit", executionId: "execution-doc", baseLedgerSha: base, changes: [{ path: "context/link.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { ref: "doc-sync-claims/plain", sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" } }] }, { actor, source: "local" });
    assert.equal(authoredLink.code, "invalid_command"); assert.equal(git(rootDir, "rev-parse", "refs/ha/canonical"), base);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

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
  const host = { run: async () => { throw new Error("unused"); }, read: async () => { throw new Error("unused"); }, bootstrap: async () => ({}), admin: async () => ({}),
    status: () => ({ daemonId: "test", pid: process.pid, repos: [] }), close: async () => undefined };
  const server = createJsonRpcProtocolServer({ host, authContext: { transportKind: "unix-socket" } });
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: -1 } });
  assert.ok(response && !Array.isArray(response) && "result" in response); if (response && !Array.isArray(response) && "result" in response) {
    const receipt = response.result as Record<string, unknown>; assert.equal(receipt.outcome, "rejected"); assert.equal(receipt.opId, "N/A"); assert.equal(receipt.origin, "daemon"); }
  await server.handle({ jsonrpc: "2.0", id: 2, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } });
  const malformed = await server.handle({ jsonrpc: "2.0", id: 3, method: "daemon.status", params: "not-an-object" });
  assert.ok(malformed && !Array.isArray(malformed) && "result" in malformed); if (malformed && !Array.isArray(malformed) && "result" in malformed) assert.equal((malformed.result as Record<string, unknown>).code, "invalid_request");
});

test("read-only principal cannot write or admin while semantic capabilities pass", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-rbac-surfaces-")), root = path.join(parent, "repo"), second = path.join(parent, "second"), userRoot = path.join(parent, "user");
  const ids = { reader: 4101, writer: 4102, arbiter: 4103, admin: 4104 }; [root, second].forEach((repo) => rbacRepo(repo, ids));
  const auth = (ownerUid: number) => ({ transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" } } as const);
  const host = await openDaemonHost({ daemonId: "rbac", userRoot });
  try {
    assert.equal((await rpc(host, auth(ids.admin), "daemon.repo.register", { rootDir: root, repoId: "rbac" })).outcome, "applied");
    const created = await host.run("rbac", { kind: "task-create", taskId: "task-rbac", title: "RBAC", completionGateIds: [] }, auth(ids.writer)); assert.equal(created.outcome, "applied");
    assert.equal((await host.run("rbac", { kind: "task-show", taskId: "task-rbac" }, auth(ids.reader))).outcome, "applied");
    const deniedWrite = await host.run("rbac", { kind: "task-create", taskId: "task-denied", title: "Denied", completionGateIds: [] }, auth(ids.reader));
    assert.equal(deniedWrite.outcome, "rejected"); assert.equal(deniedWrite.code, "rbac_forbidden");
    assert.equal((await host.run("rbac", { kind: "doc-status", paths: ["context/notes.md"] }, auth(ids.reader))).outcome, "applied");
    assert.equal((await host.run("rbac", { kind: "doc-submit" }, auth(ids.reader))).code, "rbac_forbidden");
    const deniedReview = await host.run("rbac", { kind: "task-review-execution", taskId: "task-rbac" }, auth(ids.reader));
    assert.equal(deniedReview.outcome, "rejected"); assert.equal(deniedReview.code, "rbac_forbidden");
    const deniedAdmin = await rpc(host, auth(ids.reader), "daemon.repo.register", { rootDir: second, repoId: "second" });
    assert.equal(deniedAdmin.outcome, "rejected"); assert.equal(deniedAdmin.code, "rbac_forbidden");
    const executionId = "exec-rbac", commitSha = "a".repeat(40);
    assert.equal((await host.run("rbac", { kind: "task-start", taskId: "task-rbac", executionId }, auth(ids.writer))).outcome, "applied");
    assert.equal((await host.run("rbac", { kind: "task-submit", taskId: "task-rbac", executionId, claim: "done", commitSha }, auth(ids.writer))).outcome, "applied");
    const review = await host.run("rbac", { kind: "task-review-execution", taskId: "task-rbac", executionId, reviewKind: "anti_entropy", verdict: "approved",
      reviewId: "review-rbac", reason: "checked", commitSha, iteration: 0 }, auth(ids.arbiter)); assert.equal(review.outcome, "applied", JSON.stringify(review));
    assert.equal((await rpc(host, auth(ids.admin), "daemon.repo.register", { rootDir: second, repoId: "second" })).outcome, "applied");
    assert.equal((await rpc(host, auth(ids.reader), "daemon.repo.unregister", { repoId: "second" })).code, "rbac_forbidden");
    assert.equal((await rpc(host, auth(ids.admin), "daemon.repo.unregister", { repoId: "second" })).outcome, "applied");
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}
function rbacRepo(rootDir: string, ids: Record<"reader" | "writer" | "arbiter" | "admin", number>): void { mkdirSync(rootDir, { recursive: true }); initRepo(rootDir); mkdirSync(path.join(rootDir, "harness"));
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), "schema: harness-anything/v1\nname: rbac\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n");
  const people = Object.entries(ids).map(([role, uid]) => ({ personId: role, displayName: role, roles: [role], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }] }));
  const roles = [{ roleId: "reader", commandClasses: ["repo-read"] }, { roleId: "writer", commandClasses: ["repo-write"] }, { roleId: "arbiter", commandClasses: ["arbiter"] }, { roleId: "admin", commandClasses: ["admin"] }];
  writeFileSync(path.join(rootDir, "harness/people.yaml"), `${JSON.stringify({ schema: "harness-people/v1", people, roles }, null, 2)}\n`); git(rootDir, "add", "harness"); git(rootDir, "commit", "--quiet", "-m", "add RBAC fixture"); }
async function rpc(host: Awaited<ReturnType<typeof openDaemonHost>>, auth: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2], method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = createJsonRpcProtocolServer({ host, authContext: auth }); await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } });
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method, params }); assert.ok(response && !Array.isArray(response) && "result" in response); return (response as { result: Record<string, unknown> }).result; }
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

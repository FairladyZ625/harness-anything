// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { registerDaemonRepo, sha256Bytes } from "../../kernel/src/index.ts";
import { openDaemonHost, type DaemonHost } from "../src/daemon-host.ts";
import { runFleetEdgeDocSync } from "../src/fleet-edge-doc-sync.ts";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetTlsCenter } from "../src/fleet/center.ts";
import { runFleetWriteClient } from "../src/fleet/edge.ts";

const replicaQuota = 64 * 1024 * 1024;
const nodes = ["node-one", "node-two"] as const;
type NodeId = typeof nodes[number];

async function pushRejectionFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-doc-sync-ok-"));
  const repo = path.join(root, "repo");
  const userRoot = path.join(root, "user");
  const stateRoot = path.join(root, "state");
  const keyFile = path.join(root, "tls.key");
  const certFile = path.join(root, "tls.crt");
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  const git = (...args: readonly string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fleet Doc Sync Test");
  git("config", "user.email", "fleet-doc-sync@example.invalid");
  git("commit", "--allow-empty", "-qm", "base");
  writeFileSync(path.join(repo, "harness/harness.yaml"), "schema: harness-anything/v1\nname: fleet-doc-sync\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n");
  git("add", "harness");
  git("commit", "-qm", "harness");
  registerDaemonRepo({ canonicalRoot: repo, repoId: "fleet-doc-sync-repo", userRoot, createConvenienceLinks: false });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-subj", "/CN=localhost", "-days", "1", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  const key = readFileSync(keyFile);
  const cert = readFileSync(certFile);
  const host = await openDaemonHost({ daemonId: "fleet-doc-sync-center", userRoot });
  await host.attachmentsSettled();
  const assignment = (nodeId: NodeId): FleetAssignmentRecord => ({
    nodeId,
    assignmentId: `assignment-${nodeId}`,
    repoId: "fleet-doc-sync-repo",
    taskId: "task-seeded",
    executionId: "exe-seeded",
    paths: ["context/shared-notes.md"],
    viewId: `${nodeId}-view`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    actor: { principal: { personId: `person-${nodeId}` }, executor: { kind: "agent", id: `agent-${nodeId}` } }
  });
  const assignments = new Map(nodes.map((nodeId) => [assignment(nodeId).assignmentId, assignment(nodeId)]));
  let center: FleetTlsCenter | null = null;
  let race: { readonly path: string; readonly base: string; readonly centerBody: string } | null = null;
  let raceInjected = false;
  const centerHost: Pick<DaemonHost, "replica" | "run" | "status"> = {
    replica: (...args) => host.replica(...args),
    status: () => host.status(),
    run: async (repoId, action, auth) => {
      if (race !== null && action.kind === "doc-status" && auth.assignmentBinding?.nodeId === "node-one") {
        const pending = race;
        race = null;
        if (center === null) throw new Error("fleet center is not ready");
        const moved = await runFleetWriteClient({
          hostname: "127.0.0.1",
          port: center.port,
          ca: cert,
          servername: "localhost",
          nodeId: "node-two",
          credential: "secret-node-two",
          assignmentId: "assignment-node-two",
          timeoutMs: 30_000,
          channel: "collaborator",
          changes: [{ path: pending.path, body: pending.centerBody, baseBlobSha256: sha256Bytes(Buffer.from(pending.base)) }]
        });
        assert.equal(moved.center.outcome, "applied", JSON.stringify(moved.center));
        raceInjected = true;
      }
      return host.run(repoId, action, auth);
    }
  };
  center = await listenFleetTls({
    host: centerHost,
    stateRoot,
    key,
    cert,
    replicaDiskQuotaBytes: replicaQuota,
    authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
    resolveAssignment: (assignmentId) => assignments.get(assignmentId) ?? null
  });
  const edgeRoot = (nodeId: NodeId): string => path.join(root, `${nodeId}-edge`);
  const workspaceRoot = (nodeId: NodeId): string => path.join(root, `${nodeId}-workspace`);
  for (const nodeId of nodes) mkdirSync(workspaceRoot(nodeId), { recursive: true });
  const channel = (nodeId: NodeId) => ({
    host: "127.0.0.1",
    port: center!.port,
    caPath: certFile,
    servername: "localhost",
    nodeId,
    credential: `secret-${nodeId}`,
    assignmentId: `assignment-${nodeId}`,
    repoId: "fleet-doc-sync-repo",
    viewRoot: edgeRoot(nodeId),
    quotaBytes: replicaQuota,
    workspaceRoot: workspaceRoot(nodeId)
  });
  const rawWrite = (nodeId: NodeId, changes: readonly { readonly path: string; readonly body: string; readonly baseBlobSha256?: string | null }[]) => runFleetWriteClient({ ...channel(nodeId), ca: cert, hostname: "127.0.0.1", timeoutMs: 30_000, channel: "collaborator", changes });
  const edgeDocSync = (nodeId: NodeId, paths: readonly string[]) => runFleetEdgeDocSync({ payload: { ...channel(nodeId), paths } });
  const writeWorktree = (nodeId: NodeId, logicalPath: string, body: string): void => {
    const view = locateFleetMirrorView(edgeRoot(nodeId), "fleet-doc-sync-repo");
    assert.ok(view, "mirror view must exist before its worktree is changed");
    const target = path.join(view.worktreeRoot, ...logicalPath.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  return {
    rawWrite,
    edgeDocSync,
    writeWorktree,
    armBaseBlobRace: (path: string, base: string, centerBody: string) => { race = { path, base, centerBody }; },
    raceInjected: () => raceInjected,
    conflicts: () => readdirSync(path.join(workspaceRoot("node-one"), ".harness", "conflicts")).filter((entry) => entry.startsWith("cflt-")),
    close: async () => { await center!.close(); await host.close(); rmSync(root, { recursive: true, force: true }); }
  };
}

test("push-rejected base_blob_changed staging is rejected instead of applied", { timeout: 60_000 }, async (t) => {
  const fixture = await pushRejectionFixture();
  t.after(() => fixture.close());
  const shared = "context/shared-notes.md";
  const base = "# Shared\n\nbaseline.\n";
  assert.equal((await fixture.rawWrite("node-one", [{ path: shared, body: base }])).center.outcome, "applied");
  assert.equal((await fixture.edgeDocSync("node-one", [shared])).ok, true);
  fixture.writeWorktree("node-one", shared, `${base}\nedge-local change.\n`);
  fixture.armBaseBlobRace(shared, base, `${base}\npeer-center change.\n`);

  const receipt = await fixture.edgeDocSync("node-one", [shared]);

  assert.equal(fixture.raceInjected(), true, "the peer must move the shared path after compare and before submit");
  assert.equal(receipt.ok, false, JSON.stringify(receipt));
  assert.equal(receipt.outcome, "op_rejected");
  assert.equal(receipt.code, "base_blob_changed");
  assert.equal(receipt.syncState, "CONFLICT_STAGED");
  assert.equal(receipt.canonicalOutcome, "op_rejected");
  assert.equal(receipt.mirrorOutcome, "pull_blocked");
  assert.equal(fixture.conflicts().length, 1, "the losing local bytes must be staged for an explicit exit");
});
